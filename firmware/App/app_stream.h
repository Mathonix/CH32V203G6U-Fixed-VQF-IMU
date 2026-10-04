#pragma once
#include "../Protocol/proto_defs.h"
extern uint16_t app_stream_rate;
extern output_config_t app_output;
extern uint8_t app_stream_sequence;
void app_stream_init(void);
void app_stream_poll(void);
void app_stream_changed(void);
bool app_rate_valid(uint16_t rate);
void app_vofa(void);
