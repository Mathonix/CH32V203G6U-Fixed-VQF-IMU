#include <assert.h>
#include <limits.h>
#include <stdint.h>
#include "imu_numeric.h"

int main(void)
{
    uint8_t saturated;
    int32_t previous;
    int32_t raw;
    int16_t value;

    assert(imu_accel_raw_to_q30(16383, 131072, &saturated) == 2147352576 && !saturated);
    assert(imu_accel_raw_to_q30(16384, 131072, &saturated) == INT32_MAX && saturated);
    assert(imu_accel_raw_to_q30(-16384, 131072, &saturated) == INT32_MIN && !saturated);
    assert(imu_accel_raw_to_q30(-16385, 131072, &saturated) == INT32_MIN && saturated);
    assert(imu_accel_raw_to_q30(-32768, 65536, &saturated) == INT32_MIN && !saturated);
    assert(imu_accel_raw_to_q30(32767, 65536, &saturated) == 2147418112 && !saturated);
    assert(imu_gyro_raw_to_centidps(32767, 1, &saturated) == INT16_MAX && saturated);
    assert(imu_gyro_raw_to_centidps(-32768, 1, &saturated) == INT16_MIN && saturated);
    assert(imu_gyro_raw_to_centidps(32767, 0, &saturated) == 14335 && !saturated);
    assert(imu_gyro_raw_to_centidps(-32768, 0, &saturated) == -14336 && !saturated);

    for(int fs = 0; fs <= 1; ++fs)
    {
        previous = INT16_MIN;
        for(raw = INT16_MIN; raw <= INT16_MAX; ++raw)
        {
            value = imu_gyro_raw_to_centidps((int16_t)raw, (uint8_t)fs, &saturated);
            assert(value >= previous);
            if(saturated) assert(value == INT16_MIN || value == INT16_MAX);
            previous = value;
        }
    }
    return 0;
}
