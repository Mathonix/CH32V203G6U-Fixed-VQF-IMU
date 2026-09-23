#pragma once
#include <stdint.h>
#include <limits.h>

/* Pure conversion helpers, shared by the firmware and host boundary tests. */
static inline int32_t imu_accel_raw_to_q30(int16_t raw, int32_t scale,
                                           uint8_t *saturated)
{
    int64_t value = (int64_t)raw * scale;
    *saturated = 0U;
    if(value > INT32_MAX) { *saturated = 1U; return INT32_MAX; }
    if(value < INT32_MIN) { *saturated = 1U; return INT32_MIN; }
    return (int32_t)value;
}

static inline int16_t imu_gyro_raw_to_centidps(int16_t raw, uint8_t fs_2000,
                                                uint8_t *saturated)
{
    int32_t value = fs_2000 ? (int32_t)raw * 7 : ((int32_t)raw * 7) / 16;
    *saturated = 0U;
    if(value > INT16_MAX) { *saturated = 1U; return INT16_MAX; }
    if(value < INT16_MIN) { *saturated = 1U; return INT16_MIN; }
    return (int16_t)value;
}
