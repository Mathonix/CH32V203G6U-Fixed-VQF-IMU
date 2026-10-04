#include "acc_params.h"
#include "acc_cal_limits.h"
#include <math.h>
bool acc_params_valid(const acc_calibration_t *c)
{
    unsigned i;
    if(!c || c->valid>1) return false;
    for(i=0;i<3;i++) if(!isfinite(c->bias_g[i]) || !isfinite(c->scale[i]) ||
        fabsf(c->bias_g[i])>APP_ACC_CAL_MAX_BIAS_G ||
        c->scale[i]<APP_ACC_CAL_MIN_SCALE || c->scale[i]>APP_ACC_CAL_MAX_SCALE) return false;
    return true;
}
void acc_params_identity(acc_calibration_t *c)
{ unsigned i; c->valid=0; for(i=0;i<3;i++) { c->bias_g[i]=0; c->scale[i]=1; } }
