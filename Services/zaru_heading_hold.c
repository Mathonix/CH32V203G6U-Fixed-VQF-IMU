#include "zaru_heading_hold.h"
#include "../Utils/div64.h"
zaru_heading_hold_t zaru_heading;
static int32_t wrap(int32_t yaw)
{ while(yaw>180000) yaw-=360000; while(yaw<-180000) yaw+=360000; return yaw; }
int32_t zaru_heading_update(int32_t yaw,uint32_t rate2,bool acc_ok,uint32_t dt,bool enabled)
{
    zaru_heading_hold_t *s=&zaru_heading;
    if(!dt || dt>100000U) return s->active ? s->held_mdeg : wrap(yaw+s->offset_mdeg);
    /* Signed difference as unsigned magnitude avoids overflow above INT32_MAX.
     * rate2 <= 3*32767^2; magnitude*dt fits u64, denominator < 2^24. */
    {
        bool up=rate2>s->rate2_lp;
        uint32_t d=up ? rate2-s->rate2_lp : s->rate2_lp-rate2;
        uint32_t step=(uint32_t)div64_u24((uint64_t)d*dt,10000U+dt);
        if(up) s->rate2_lp+=step; else s->rate2_lp-=step;
    }
    if(!enabled) { s->active=false; s->enter_us=s->exit_us=0; }
    else if(s->active) {
        if(rate2>700U*700U) s->exit_us+=dt; else s->exit_us=0;
        if(s->exit_us<3000U) {
            s->offset_mdeg=wrap(s->held_mdeg-yaw); return s->held_mdeg;
        }
        /* Retain last held offset and do not re-enter on the exit sample. */
        s->active=false; s->enter_us=s->exit_us=0;
    } else {
        if(rate2>700U*700U || s->rate2_lp>=300U*300U || !acc_ok) s->enter_us=0;
        else s->enter_us+=dt;
        if(s->enter_us>=50000U) {
            s->held_mdeg=wrap(yaw+s->offset_mdeg); s->active=true;
            s->enter_us=s->exit_us=0; return s->held_mdeg;
        }
    }
    return wrap(yaw+s->offset_mdeg);
}
