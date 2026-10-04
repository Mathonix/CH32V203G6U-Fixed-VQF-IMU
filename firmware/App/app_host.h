#pragma once
#include "../Protocol/proto_parser.h"
#include "../Services/sensor_service.h"
extern proto_parser_t app_parser;
extern uint32_t app_unknown_commands,app_rx_rate,app_tx_rate;
extern bool app_settings_mode,app_reset_pending;
void app_host_init(void);
void app_host_poll(void);
void app_command(uint8_t id,uint8_t seq,const uint8_t *payload,uint8_t length);
void app_command_poll(void);
bool app_command_pending(void);
bool app_send(uint8_t id,uint8_t seq,const uint8_t *payload,uint8_t length,uint8_t priority);
void app_reply_config(uint8_t seq);
void app_reply_filter(uint8_t seq);
void app_reply_acc_cal(uint8_t seq);
uint8_t app_device_flags(const sensor_sample_t *sample);
