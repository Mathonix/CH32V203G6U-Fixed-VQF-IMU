#include "imu_adapter.h"
#include "../User/fixed_vqf.h"
#include "../Services/time_service.h"
#include "../BSP/board_config.h"
#include "../Services/acc_processing.h"
/* Adapter for the existing LSM6DSV + fixed-VQF acquisition engine. */
extern volatile int32_t vqf_euler_q16[3],vqf_quat_q30[4];
extern volatile int16_t lsm_gyro_x,lsm_gyro_y,lsm_gyro_z,lsm_accel_x,lsm_accel_y,lsm_accel_z,lsm_temperature_raw;
extern volatile uint32_t vqf_update_count,lsm_spi_error_count,lsm_ready_timeout_count,cpu_load_permille,imu_last_sample_us;
extern volatile uint8_t lsm_test_result;
extern volatile int32_t gyro_cal_bias_q16[3];
void imu_adapter_read(sensor_sample_t *s)
{
    int16_t g[3]={lsm_gyro_x,lsm_gyro_y,lsm_gyro_z};
    int16_t a[3]={lsm_accel_x,lsm_accel_y,lsm_accel_z}; uint8_t i;
    s->timestamp_us=imu_last_sample_us; s->sample_count=vqf_update_count;
    extern volatile uint8_t gyro_cal_status;
    s->rest=gyro_cal_status==2U;
    s->errors=lsm_spi_error_count+lsm_ready_timeout_count;
    s->valid=lsm_test_result==3U && s->sample_count!=0 && (uint32_t)(time_us()-s->timestamp_us)<HOST_SENSOR_WARNING_US;
    s->temperature_cdeg=(int16_t)(2500+(int32_t)lsm_temperature_raw*100/256);
    s->cpu_load=(uint16_t)(cpu_load_permille>1000 ? 1000 : cpu_load_permille);
    for(i=0;i<3;i++) {
        s->euler_mdeg[i]=(int32_t)((int64_t)vqf_euler_q16[2U-i]*1000/65536);
#if LSM6DSV_GYRO_FS_2000DPS
        s->gyro_mdps[i]=(int32_t)g[i]*70;
#else
        s->gyro_mdps[i]=(int32_t)g[i]*35/8;
#endif
        /* VQF bias is rad/s Q16. Keep the published gyro fields raw; only
         * ZARU sees the residual, before the estimator's 30Hz input LPF. */
        s->gyro_unbiased_mdps[i]=s->gyro_mdps[i]-(int32_t)((int64_t)gyro_cal_bias_q16[i]*57296/65536);
        int32_t q20=(int32_t)a[i]*(LSM6DSV_ACCEL_FS_4G ? 128 : 64);
        s->raw_accel_umss[i]=(int32_t)((int64_t)q20*9806650/1048576);
        s->accel_umss[i]=(int32_t)((int64_t)acc_correct_q20(i,q20)*9806650/1048576);
    }
    for(i=0;i<4;i++) s->quaternion_q30[i]=vqf_quat_q30[i];
}
