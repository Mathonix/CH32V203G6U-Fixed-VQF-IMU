#pragma once
#include "acc_params.h"
void acc_processing_init(const acc_calibration_t *cal);
/* Sensor-frame g Q20. No floating point on the 2kHz path. */
int32_t acc_correct_q20(unsigned axis,int32_t nominal_q20);
