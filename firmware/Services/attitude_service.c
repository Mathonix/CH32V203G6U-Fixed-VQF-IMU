#include "attitude_service.h"
#include "time_service.h"
#include "zaru_heading_hold.h"
#include "../Utils/div64.h"
#include "../User/fixed_vqf.h"
extern fixed_vqf_t fixed_vqf;
/* Profiles select both core VQF tuning and output angle smoothing.
 * Profile 3 uses the balanced core with UART-only ZARU. */
uint8_t attitude_profile;
static int64_t filtered_q16[3];
static uint32_t last_us;
static bool initialized;
static int32_t yaw_zero,published_mdeg[3];
static int32_t wrap(int32_t angle)
{ while(angle>180000) angle-=360000; while(angle<-180000) angle+=360000; return angle; }
uint16_t attitude_rest_tau_ms(void)
{ static const uint16_t tau[4]={150,500,1500,500}; return tau[attitude_profile]; }
void attitude_service_init(uint8_t profile)
{
    if(profile>=4) profile=1;
    fixed_vqf_set_profile(&fixed_vqf,profile);
    attitude_profile=profile; /* Keep output LP history across live switches. */
    if(profile!=3) { zaru_heading.active=false; zaru_heading.enter_us=zaru_heading.exit_us=0; }
}
void attitude_service_apply(sensor_sample_t *s)
{
    static const uint16_t moving_tau[4]={40,100,200,100};
    uint32_t delta=(uint32_t)(s->timestamp_us-last_us),tau; uint8_t i;
    if(!s->valid) { initialized=false; return; }
    /* Main services this at the 1kHz attitude cadence. UART/zero-yaw queries
     * reuse the same timestamp; never advance confirmation twice. */
    if(initialized && s->timestamp_us==last_us) {
        for(i=0;i<3;i++) s->euler_mdeg[i]=published_mdeg[i];
        s->euler_mdeg[0]=wrap(s->euler_mdeg[0]-yaw_zero); return;
    }
    if(!initialized || delta>100000U) {
        for(i=0;i<3;i++) filtered_q16[i]=(int64_t)s->euler_mdeg[i]*65536LL;
        initialized=true;
    } else if(delta) {
        tau=(uint32_t)(s->rest ? attitude_rest_tau_ms() : moving_tau[attitude_profile])*1000U;
        for(i=0;i<3;i++) {
            int64_t d=(int64_t)s->euler_mdeg[i]*65536LL-filtered_q16[i];
            if(i!=1) { if(d>180000LL*65536) d-=360000LL*65536; if(d<-180000LL*65536) d+=360000LL*65536; }
            /* Same value as d*delta/(tau+delta) (C truncation toward zero):
             * |d| <= 360000*65536 (< 2^35), delta <= 100000 (< 2^17), so
             * |d|*delta < 2^52 fits; divisor tau+delta <= 1600000 < 2^24. */
            { uint64_t mag=(uint64_t)(d<0 ? -d : d)*delta, q=div64_u24(mag,tau+delta);
              filtered_q16[i]+=d<0 ? -(int64_t)q : (int64_t)q; }
            if(i!=1) filtered_q16[i]=(int64_t)wrap((int32_t)(filtered_q16[i]/65536))*65536LL+(filtered_q16[i]%65536);
        }
    }
    last_us=s->timestamp_us;
    for(i=0;i<3;i++) s->euler_mdeg[i]=(int32_t)(filtered_q16[i]/65536);
    {
        uint32_t rate2=0,acc2=0; bool acc_ok=true;
        for(i=0;i<3;i++) {
            /* Saturation above 32.767 dps bounds squared energy to u32;
             * motion is already far beyond the fixed 0.7 dps exit limit. */
            int32_t g=s->gyro_unbiased_mdps[i],a=s->accel_umss[i]/1024;
            if(g>32767) g=32767;
            if(g<-32767) g=-32767;
            rate2+=(uint32_t)(g*g);
            /* |a| >= g+0.15 cannot satisfy the acceleration entry gate. */
            if(a>9723 || a<-9723) acc_ok=false;
            else acc2+=(uint32_t)(a*a);
        }
        acc_ok=acc_ok && acc2>=(uint32_t)(9431U*9431U) && acc2<(uint32_t)(9724U*9724U);
        s->euler_mdeg[0]=zaru_heading_update(s->euler_mdeg[0],rate2,acc_ok,delta,attitude_profile==3);
    }
    for(i=0;i<3;i++) published_mdeg[i]=s->euler_mdeg[i];
    s->euler_mdeg[0]=wrap(s->euler_mdeg[0]-yaw_zero);
}
void attitude_service_poll(void)
{ sensor_sample_t s; sensor_service_get(&s); attitude_service_apply(&s); }
bool attitude_zero_yaw(void)
{
    sensor_sample_t s; sensor_service_get(&s); if(!s.valid) return false;
    attitude_service_apply(&s); yaw_zero=wrap(yaw_zero+s.euler_mdeg[0]); return true;
}
