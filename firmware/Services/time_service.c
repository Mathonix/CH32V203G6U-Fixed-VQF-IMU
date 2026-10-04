#include "time_service.h"
extern uint32_t VQF_TimeUs(void);
static volatile uint32_t milliseconds;
static uint16_t remainder_us;
void time_service_tick(uint16_t period_us)
{
    remainder_us=(uint16_t)(remainder_us+period_us);
    if(remainder_us>=1000U) { milliseconds++; remainder_us-=1000U; }
}
uint32_t time_ms(void) { return milliseconds; }
uint32_t time_us(void) { return VQF_TimeUs(); }
