#include "app_stream.h"
#include "app_host.h"
#include "../Protocol/proto_codec.h"
#include "../Transport/transport.h"
#include "../Services/time_service.h"
#include "../Services/attitude_service.h"
#include "../Storage/nv_config.h"
#include "../User/fixed_vqf.h"
uint16_t app_stream_rate;
output_config_t app_output;
uint8_t app_stream_sequence;
static uint32_t next_data_us;
bool app_rate_valid(uint16_t rate)
{ return rate && rate<=FIXED_VQF_SAMPLE_HZ && FIXED_VQF_SAMPLE_HZ%rate==0; }
void app_stream_changed(void) { next_data_us=time_us(); transport_discard_telemetry(); }
void app_vofa(void) { app_output.format=FORMAT_JUSTFLOAT; app_stream_changed(); }
void app_stream_init(void)
{ app_stream_rate=nv_saved.output_hz; app_output=nv_saved.uart; app_stream_sequence=0; next_data_us=time_us(); }
void app_stream_poll(void)
{
    uint8_t frame[PROTO_MAX_FRAME],i; uint16_t length; uint32_t now=time_us(),period;
    float fields[9]; sensor_sample_t s;
    if((int32_t)(now-next_data_us)<0) return;
    period=1000000U/app_stream_rate; next_data_us+=period;
    if((int32_t)(now-next_data_us)>=0) next_data_us=now+period;
    sensor_service_get(&s); attitude_service_apply(&s);
    if(!s.valid) return;
    for(i=0;i<3;i++) {
        fields[i]=(float)s.euler_mdeg[i]/1000.0f;
        fields[3+i]=(float)s.accel_umss[i]/1000000.0f;
        fields[6+i]=(float)s.gyro_mdps[i]/1000.0f;
    }
    length=proto_output(frame,sizeof(frame),app_stream_sequence,&app_output,fields,s.temperature_cdeg,
                        app_device_flags(&s),(uint16_t)time_ms());
    if(length) {
        /* Advance for each produced binary sample, so dropped queues leave a gap. */
        if(app_output.format==FORMAT_CUSTOM || (app_output.format==FORMAT_LEGACY && app_output.legacy_mode>=1 && app_output.legacy_mode<=3)) app_stream_sequence++;
        transport_send(frame,length,TX_LOW);
    }
}
