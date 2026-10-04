#pragma once
#include <stdint.h>
uint32_t time_us(void);
uint32_t time_ms(void);
void time_service_tick(uint16_t period_us);
