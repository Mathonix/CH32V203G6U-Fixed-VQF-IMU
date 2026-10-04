#include "acc_processing.h"
static int32_t bias[3],scale[3];
static bool enabled;
void acc_processing_init(const acc_calibration_t *c)
{
    unsigned i; enabled=c->valid!=0;
    for(i=0;i<3;i++) { bias[i]=(int32_t)(c->bias_g[i]*1048576.0f); scale[i]=(int32_t)(c->scale[i]*1048576.0f); }
}
int32_t acc_correct_q20(unsigned axis,int32_t value)
{ return enabled && axis<3 ? (int32_t)(((int64_t)value-bias[axis])*scale[axis]/1048576LL) : value; }
