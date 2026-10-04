#include "app_host.h"
#include "app_stream.h"
#include "app_acc_cal.h"
#include "../Protocol/proto_codec.h"
#include "../Transport/transport.h"
#include "../BSP/board_uart.h"
#include "../BSP/board_config.h"
#include "../Services/time_service.h"
#include "../Services/attitude_service.h"
#include "../Storage/nv_config.h"
#include "../Storage/ota_stage.h"
#include "../User/fixed_vqf.h"
#include <string.h>
proto_parser_t app_parser;
uint32_t app_unknown_commands,app_rx_rate,app_tx_rate;
bool app_settings_mode,app_reset_pending;
static uint32_t rate_time,last_rx,last_tx;
bool app_send(uint8_t id,uint8_t seq,const uint8_t *payload,uint8_t length,uint8_t priority)
{
    uint8_t frame[PROTO_MAX_FRAME]; uint16_t n=proto_encode(frame,sizeof(frame),id,seq,payload,length);
    return n && transport_send(frame,n,priority);
}
uint8_t app_device_flags(const sensor_sample_t *s)
{ return s->valid ? ((s->rest ? FLAG_REST_DETECTED : 0) | (nv_saved.acc.valid ? FLAG_CALIB_DONE : 0)) : FLAG_SENSOR_ERROR; }
void app_reply_config(uint8_t seq)
{
    uint8_t p[28]={0}; uint16_t range=LSM6DSV_GYRO_FS_2000DPS ? 2000 : 125;
    p[0]=3; p[1]=0; p[6]=(1U<<2)|(1U<<6)|(1U<<7);
    proto_put_u16(p+8,app_stream_rate); p[10]=app_output.format; p[11]=app_output.legacy_mode;
    proto_put_u16(p+12,app_output.mask); p[14]=FORMAT_CUSTOM; /* absent USB port, mask=0 */
    proto_put_u16(p+22,range); proto_put_u16(p+24,range); proto_put_u16(p+26,nv_saved.output_hz);
    app_send(MSG_DEVICE_CONFIG,seq,p,sizeof(p),TX_HIGH);
}
void app_reply_filter(uint8_t seq)
{
    uint8_t p[16]={0}; p[0]=1; p[1]=attitude_profile; p[2]=nv_saved.filter_profile; p[3]=4;
    proto_put_u16(p+4,FIXED_VQF_SAMPLE_HZ); proto_put_float(p+8,0.0f);
    proto_put_float(p+12,(float)fixed_vqf_tau_acc_ms(attitude_profile)/1000.0f);
    app_send(MSG_FILTER_CONFIG,seq,p,sizeof(p),TX_HIGH);
}
void app_reply_acc_cal(uint8_t seq)
{
    uint8_t p[60]={0},i; sensor_sample_t s; sensor_service_get(&s);
    uint32_t now=time_ms(),elapsed=now-acc_cal_state.face_start_ms;
    p[0]=1; p[1]=acc_cal_state.status; p[2]=acc_cal_state.phase;
    p[3]=acc_cal_state.candidate; p[4]=acc_cal_state.face_mask; p[5]=1; p[6]=nv_saved.acc.valid;
    proto_put_u16(p+8,acc_cal_state.progress); proto_put_u16(p+10,acc_cal_state.error);
    proto_put_u32(p+12,acc_cal_state.samples);
    proto_put_u32(p+16,p[1] ? (acc_cal_state.active ? now : acc_cal_state.end_ms)-acc_cal_state.start_ms : 0);
    proto_put_u32(p+20,acc_cal_state.active && elapsed<60000 ? 60000-elapsed : 0);
    for(i=0;i<3;i++) {
        proto_put_float(p+24+4*i,nv_saved.acc.bias_g[i]); proto_put_float(p+36+4*i,nv_saved.acc.scale[i]);
        proto_put_float(p+48+4*i,(float)s.raw_accel_umss[i]/9806650.0f);
    }
    app_send(MSG_ACC_CAL,seq,p,sizeof(p),TX_HIGH);
}
void app_host_init(void)
{
    nv_config_load(); app_acc_cal_init(); attitude_service_init(nv_saved.filter_profile);
    transport_uart.init(); proto_parser_init(&app_parser,app_command); app_parser.vofa_callback=app_vofa;
    app_unknown_commands=app_rx_rate=app_tx_rate=0; app_settings_mode=app_reset_pending=false;
    rate_time=time_ms(); last_rx=last_tx=0; app_stream_init();
}
void app_host_poll(void)
{
    uint8_t byte; uint16_t budget=128; uint32_t now=time_ms(),elapsed,rx,tx;
    transport_uart.poll(); app_command_poll(); app_acc_cal_poll();
    if(!app_command_pending() && transport_command_room()) proto_parser_timeout(&app_parser,now);
    while(budget-- && !app_command_pending() && transport_command_room() && transport_read(&byte))
        proto_parser_byte(&app_parser,byte,now);
    if(!app_command_pending() && acc_cal_state.phase!=ACC_CAL_PHASE_SAVING && !ota_active()) app_stream_poll(); /* OTA pauses telemetry */
    transport_uart.poll(); elapsed=(uint32_t)(now-rate_time);
    if(elapsed>=1000U) {
        rx=board_uart_rx_bytes(); tx=transport_tx_bytes;
        /* x*1000/e == (x/e)*1000 + (x%e)*1000/e exactly; (x%e)*1000 < e*1000
         * fits 32 bits while e < 4294967 ms (71 min, far beyond the 2 s IWDG). */
        { uint32_t drx=rx-last_rx,dtx=tx-last_tx;
          app_rx_rate=(drx/elapsed)*1000U+(drx%elapsed)*1000U/elapsed;
          app_tx_rate=(dtx/elapsed)*1000U+(dtx%elapsed)*1000U/elapsed; }
        last_rx=rx; last_tx=tx; rate_time=now;
    }
}
