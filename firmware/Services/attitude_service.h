#pragma once
#include "sensor_service.h"
extern uint8_t attitude_profile;
void attitude_service_init(uint8_t profile);
void attitude_service_apply(sensor_sample_t *sample);
void attitude_service_poll(void);
bool attitude_zero_yaw(void);
uint16_t attitude_rest_tau_ms(void);
