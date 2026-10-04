#include "app_host.h"
#include "app_stream.h"
#include "app_acc_cal.h"
#include "../Protocol/proto_codec.h"
#include "../Transport/transport.h"
#include "../BSP/board_config.h"
#include "../Services/time_service.h"
#include "../Services/attitude_service.h"
#include "../Storage/nv_config.h"
#include "../Storage/ota_stage.h"
#include "../Boot/ota_layout.h"
#include "../User/fixed_vqf.h"
#include <string.h>
static uint8_t pending_cmd,pending_seq;
static nv_config_t pending_saved;
static void ack(uint8_t cmd,uint8_t seq,uint8_t status,uint16_t detail)
{ uint8_t p[4]={cmd,status,0,0}; proto_put_u16(p+2,detail); app_send(MSG_ACK,seq,p,4,TX_HIGH); }
bool app_command_pending(void) { return pending_cmd!=0 || app_reset_pending; }
static void defer_save(uint8_t id,uint8_t seq,const nv_config_t *saved)
{ pending_cmd=id; pending_seq=seq; pending_saved=*saved; transport_discard_telemetry(); }
void app_command_poll(void)
{
    uint8_t cmd,status;
    if(!transport_idle()) return;
    if(app_reset_pending) { NVIC_SystemReset(); return; }
    if(!pending_cmd) return;
    cmd=pending_cmd; status=nv_config_save(&pending_saved) ? ACK_SUCCESS : ACK_EXEC_FAILED;
    if(status==ACK_SUCCESS) {
        if(cmd==CMD_SET_OUTPUT_HZ) app_stream_rate=pending_saved.output_hz;
        else if(cmd==CMD_SET_OUTPUT_CONFIG) app_output=pending_saved.uart;
        else if(cmd==CMD_SET_FILTER) attitude_service_init(pending_saved.filter_profile);
        app_stream_changed();
    }
    pending_cmd=0;
    ack(cmd,pending_seq,status,status==ACK_SUCCESS ? (cmd==CMD_SET_FILTER ? attitude_profile : 0) : 0x0607);
    if(cmd==CMD_SET_FILTER) app_reply_filter(pending_seq); else app_reply_config(pending_seq);
}
void app_command(uint8_t id,uint8_t seq,const uint8_t *p,uint8_t len)
{
    uint8_t status=ACK_SUCCESS,out[16]={0}; uint16_t detail=0; nv_config_t saved=nv_saved; sensor_sample_t s;
    switch(id) {
    case CMD_PING: if(len) status=ACK_INVALID_PARAM; break;
    case CMD_ZERO_YAW:
        if(len) status=ACK_INVALID_PARAM;
        else if(!attitude_zero_yaw()) status=ACK_EXEC_FAILED;
        break;
    case CMD_QUERY_STATUS:
        if(len) { status=ACK_INVALID_PARAM; break; }
        sensor_service_get(&s); proto_put_u32(out,FIXED_VQF_SAMPLE_HZ); proto_put_u32(out+4,app_stream_rate);
        proto_put_u16(out+8,FIXED_VQF_SAMPLE_HZ/app_stream_rate); proto_put_u16(out+10,(uint16_t)s.temperature_cdeg);
        out[12]=app_output.format==FORMAT_LEGACY ? app_output.legacy_mode : 0xFF;
        extern uint8_t CAN1_IsInitialized(void);
        out[13]=CAN1_IsInitialized(); /* Controller initialized; not proof of a working bus. */
        app_send(MSG_SYSTEM_INFO,seq,out,16,TX_HIGH); return;
    case CMD_QUERY_CONFIG:
        if(len) { status=ACK_INVALID_PARAM; break; } app_reply_config(seq); return;
    case CMD_QUERY_FIRMWARE_INFO:
        if(len) { status=ACK_INVALID_PARAM; break; }
        out[0]=1; out[1]=9; memcpy(out+2,FW_VERSION_TEXT,9);
        out[12]=OTA_PROTOCOL_VERSION; proto_put_u16(out+14,(uint16_t)OTA_APP_MAX); /* OTA capability, caps byte unchanged */
        app_send(MSG_FIRMWARE_INFO,seq,out,16,TX_HIGH); return;
    case CMD_QUERY_FILTER:
        if(len) { status=ACK_INVALID_PARAM; break; } app_reply_filter(seq); return;
    case CMD_QUERY_ACC_CAL:
        if(len) { status=ACK_INVALID_PARAM; break; } app_reply_acc_cal(seq); return;
    case CMD_ENTER_SETTINGS: case CMD_EXIT_SETTINGS:
        if(len) status=ACK_INVALID_PARAM;
        else { app_settings_mode=id==CMD_ENTER_SETTINGS; if(!app_settings_mode) app_acc_cal_cancel(); }
        break;
    case CMD_SYSTEM_RESET:
        if(len) { status=ACK_INVALID_PARAM; break; }
        /* Reserved ACK space is available before the parser dispatches. */
        ack(id,seq,ACK_SUCCESS,0); app_reset_pending=true; transport_discard_telemetry(); return;
    case CMD_SET_OUTPUT_HZ:
        if(len!=2 || !app_rate_valid(proto_get_u16(p))) { status=ACK_INVALID_PARAM; break; }
        if(acc_cal_state.active) { status=ACK_EXEC_FAILED; detail=0x0604; break; }
        saved.output_hz=proto_get_u16(p); defer_save(id,seq,&saved); return;
    case CMD_SET_OUTPUT_CONFIG:
        if(len!=5 || p[0]>1 || p[1]>1 || (proto_get_u16(p+2)&~FIELDS_ALL) || p[4]>1) { status=ACK_INVALID_PARAM; break; }
        if(p[0]!=0) { status=ACK_EXEC_FAILED; break; } /* No USB hardware transport. */
        saved.uart.format=p[1]; saved.uart.legacy_mode=0; saved.uart.mask=proto_get_u16(p+2);
        if(p[4]) {
            if(acc_cal_state.active) { status=ACK_EXEC_FAILED; detail=0x0604; break; }
            defer_save(id,seq,&saved); return;
        }
        app_output=saved.uart; app_stream_changed(); ack(id,seq,0,0); app_reply_config(seq); return;
    case CMD_SET_STREAM_MODE:
        if(len!=1 || p[0]>4) { status=ACK_INVALID_PARAM; break; }
        app_output.format=FORMAT_LEGACY; app_output.legacy_mode=p[0]; app_stream_changed(); break;
    case CMD_SET_FILTER:
        if(len!=2 || p[0]>=4 || p[1]>1) { status=ACK_INVALID_PARAM; break; }
        if(!app_settings_mode) { status=ACK_EXEC_FAILED; break; }
        saved.filter_profile=p[0];
        if(p[1]) {
            if(acc_cal_state.active) { status=ACK_EXEC_FAILED; detail=0x0604; break; }
            defer_save(id,seq,&saved); return;
        }
        attitude_service_init(p[0]); ack(id,seq,0,p[0]); app_reply_filter(seq); return;
    case CMD_SET_FUSION_MODE:
        if(len!=2 || p[0]!=0 || p[1]>1) status=ACK_INVALID_PARAM;
        else if(!app_settings_mode) status=ACK_EXEC_FAILED;
        break;
    case CMD_START_ACC_CAL:
        if(len || !app_settings_mode) { status=ACK_INVALID_PARAM; detail=0x0602; }
        else if(acc_cal_state.active) { status=ACK_EXEC_FAILED; detail=0x0604; }
        else { app_acc_cal_start(seq); ack(id,seq,0,0x0100); app_reply_acc_cal(seq); return; }
        break;
    case CMD_CANCEL_ACC_CAL:
        if(len) { status=ACK_INVALID_PARAM; break; }
        app_acc_cal_cancel(); ack(id,seq,0,0); app_reply_acc_cal(seq); return;
    case CMD_RECALIBRATE_GYRO: case CMD_START_GYRO_CAL:
        status=len ? ACK_INVALID_PARAM : ACK_EXEC_FAILED; detail=0x0601; break;
    case CMD_ENTER_BOOTLOADER:
        status=len ? ACK_INVALID_PARAM : ACK_EXEC_FAILED; break;
    case CMD_OTA_BEGIN:
        if(!app_settings_mode) { status=ACK_EXEC_FAILED; detail=OTA_ERR_SETTINGS; break; }
        if(acc_cal_state.active) { status=ACK_EXEC_FAILED; detail=0x0604; break; }
        transport_discard_telemetry(); status=ota_command(id,p,len,&detail); break;
    case CMD_OTA_WRITE: case CMD_OTA_END: case CMD_OTA_ABORT:
        status=ota_command(id,p,len,&detail); break;
    case CMD_OTA_COMMIT:
        status=ota_command(id,p,len,&detail);
        if(status!=ACK_SUCCESS) break;
        /* Header written == pending; the boot stub copies it after this reset. */
        ack(id,seq,status,detail); app_reset_pending=true; transport_discard_telemetry(); return;
    case CMD_SET_STARTUP_CONFIG:
        if((len!=3 && len!=5 && len!=7) || p[0]!=0 || p[1]>1 || p[2]>1) status=ACK_INVALID_PARAM;
        else status=ACK_EXEC_FAILED; /* No timed startup calibration/range switching yet. */
        break;
    default: status=ACK_UNKNOWN_CMD; app_unknown_commands++; break;
    }
    ack(id,seq,status,detail);
}
