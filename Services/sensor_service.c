#include "sensor_service.h"
#include "time_service.h"
#include "../BSP/board_config.h"
#include "../Drivers/imu_adapter.h"
#if ENABLE_SENSOR_MOCK
#include <string.h>
static int32_t multiply_q30(int32_t a,int32_t b)
{ return (int32_t)((int64_t)a*b/1073741824LL); }
static int32_t triangle(uint32_t ms,uint32_t period,int32_t amplitude)
{
    int32_t phase=(int32_t)((uint64_t)(ms%period)*4U*(uint32_t)amplitude/period);
    if(phase<=amplitude) return phase;
    if(phase<=3*amplitude) return 2*amplitude-phase;
    return phase-4*amplitude;
}
/* Half-angle sine/cosine in Q30, |angle| <=180 degrees. Bounded integer
 * polynomials avoid pulling software floating-point trig into 32 KB Flash. */
static void half_angle(int32_t mdeg,int32_t *sine,int32_t *cosine)
{
    int64_t x=(int64_t)mdeg*3373259426LL/360000LL;
    int64_t x2=x*x/1073741824LL,p;
    p=2959; p=-213044+p*x2/1073741824LL;
    p=8947849+p*x2/1073741824LL; p=-178956971+p*x2/1073741824LL;
    p=1073741824LL+p*x2/1073741824LL; *sine=(int32_t)(x*p/1073741824LL);
    p=26631; p=-1491308+p*x2/1073741824LL;
    p=44739243+p*x2/1073741824LL; p=-536870912+p*x2/1073741824LL;
    *cosine=(int32_t)(1073741824LL+p*x2/1073741824LL);
}
void sensor_service_get(sensor_sample_t *s)
{
    uint32_t ms=time_ms(); int32_t yaw=(int32_t)(ms%45000U)*8;
    int32_t pitch=triangle(ms,5000,5000),roll=triangle(ms,9000,3000);
    int32_t cy,sy,cp,sp,cr,sr;
    if(yaw>180000) yaw-=360000;
    half_angle(yaw,&sy,&cy); half_angle(pitch,&sp,&cp); half_angle(roll,&sr,&cr);
    memset(s,0,sizeof(*s)); s->timestamp_us=time_us(); s->sample_count=ms*2U;
    s->valid=true; s->cpu_load=0xFFFF; s->temperature_cdeg=3600;
    s->euler_mdeg[0]=yaw; s->euler_mdeg[1]=pitch; s->euler_mdeg[2]=roll;
    s->quaternion_q30[0]=multiply_q30(multiply_q30(cr,cp),cy)+multiply_q30(multiply_q30(sr,sp),sy);
    s->quaternion_q30[1]=multiply_q30(multiply_q30(sr,cp),cy)-multiply_q30(multiply_q30(cr,sp),sy);
    s->quaternion_q30[2]=multiply_q30(multiply_q30(cr,sp),cy)+multiply_q30(multiply_q30(sr,cp),sy);
    s->quaternion_q30[3]=multiply_q30(multiply_q30(cr,cp),sy)-multiply_q30(multiply_q30(sr,sp),cy);
    s->gyro_mdps[0]=triangle(ms,1300,80); s->gyro_mdps[1]=triangle(ms,1700,60); s->gyro_mdps[2]=8000;
    for(unsigned i=0;i<3;i++) s->gyro_unbiased_mdps[i]=s->gyro_mdps[i];
    s->accel_umss[2]=9806650;
    s->raw_accel_umss[2]=9806650;
}
#else
void sensor_service_get(sensor_sample_t *s) { imu_adapter_read(s); }
#endif
