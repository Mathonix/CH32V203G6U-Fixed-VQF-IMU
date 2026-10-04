#pragma once
#include <stdint.h>
#include <stdbool.h>
/* Application snapshot, in internal fixed-point units; no protocol IDs in drivers. */
typedef struct {
    uint32_t timestamp_us,sample_count,errors;
    int32_t euler_mdeg[3],quaternion_q30[4],gyro_mdps[3],accel_umss[3];
    int32_t raw_accel_umss[3],gyro_unbiased_mdps[3];
    int16_t temperature_cdeg;
    uint16_t cpu_load;
    bool valid,rest;
} sensor_sample_t;
void sensor_service_get(sensor_sample_t *sample);
