#include "app_acc_cal.h"
#include "app_host.h"
#include "app_stream.h"
#include "../Services/time_service.h"
#include "../Services/acc_processing.h"
#include "../Storage/nv_config.h"
#include "../Transport/transport.h"
#include "../Protocol/proto_codec.h"
#include <string.h>
acc_six_face_t acc_cal_state;
static uint8_t start_seq,final_sent;
static uint32_t report_ms,sample_ms,last_sample_us;
void app_acc_cal_init(void)
{ memset(&acc_cal_state,0,sizeof(acc_cal_state)); acc_processing_init(&nv_saved.acc); final_sent=1; }
void app_acc_cal_start(uint8_t seq)
{
    uint32_t now=time_ms(); acc_six_face_start(&acc_cal_state,now);
    start_seq=seq; final_sent=0; sample_ms=now-10; report_ms=now; last_sample_us=0;
}
void app_acc_cal_cancel(void) { acc_six_face_cancel(&acc_cal_state); }
int16_t app_acc_cal_led(uint16_t full)
{
    uint32_t t; uint8_t m=acc_cal_state.face_mask,n=1;
    if(!acc_cal_state.active) return -1;
    if(acc_cal_state.phase==ACC_CAL_PHASE_SAVING) return (int16_t)full; /* solid while writing Flash */
    while(m) { n+=m&1U; m>>=1; }
    if(n>6) n=6;
    t=time_ms()%1000U; /* 60 ms on / 90 ms off per pulse, rest of the second dark */
    return (t<150U*n && t%150U<60U) ? (int16_t)full : 0;
}
void app_acc_cal_poll(void)
{
    uint32_t now=time_ms(); sensor_sample_t s; float a[3],g[3]; unsigned i;
    if(acc_cal_state.active) {
        acc_six_face_tick(&acc_cal_state,now);
        if(acc_cal_state.phase==ACC_CAL_PHASE_SAVING) {
            /* Stop new telemetry so physical TX can empty before Flash. */
            transport_discard_telemetry();
            if(!app_command_pending() && transport_idle()) {
                nv_config_t saved=nv_saved; saved.acc=acc_cal_state.result;
                bool ok=nv_config_save(&saved);
                if(ok) acc_processing_init(&nv_saved.acc);
                acc_six_face_saved(&acc_cal_state,ok ? 0 : -2);
            }
        } else if((uint32_t)(now-sample_ms)>=10) {
            sample_ms=now; sensor_service_get(&s);
            if(s.valid && s.timestamp_us!=last_sample_us) {
                last_sample_us=s.timestamp_us;
                for(i=0;i<3;i++) { a[i]=(float)s.raw_accel_umss[i]/9806650.0f; g[i]=(float)s.gyro_mdps[i]/1000.0f; }
                acc_six_face_push(&acc_cal_state,now,a,g);
            }
        }
    }
    if(!final_sent && !acc_cal_state.active && transport_command_room()) {
        uint8_t p[4]={CMD_START_ACC_CAL,acc_cal_state.status==ACC_CAL_STATUS_DONE ? ACK_SUCCESS : ACK_EXEC_FAILED,0,0};
        proto_put_u16(p+2,acc_cal_state.error);
        if(app_send(MSG_ACK,start_seq,p,4,TX_HIGH)) { app_reply_acc_cal(start_seq); final_sent=1; }
    } else if(acc_cal_state.active && (uint32_t)(now-report_ms)>=200 && transport_command_room()) {
        report_ms=now; app_reply_acc_cal(start_seq);
    }
}
