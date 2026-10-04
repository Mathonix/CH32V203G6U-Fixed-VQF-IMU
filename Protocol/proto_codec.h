#pragma once
#include "proto_defs.h"
uint16_t proto_get_u16(const uint8_t *p);
uint32_t proto_get_u32(const uint8_t *p);
void proto_put_u16(uint8_t *p,uint16_t v);
void proto_put_u32(uint8_t *p,uint32_t v);
void proto_put_float(uint8_t *p,float v);
uint16_t proto_crc16(const uint8_t *data,uint16_t length);
uint16_t proto_encode(uint8_t *dst,uint16_t capacity,uint8_t id,uint8_t seq,const uint8_t *payload,uint8_t length);
uint16_t proto_output(uint8_t *dst,uint16_t capacity,uint8_t seq,const output_config_t *config,
                      const float fields[9],int16_t temperature,uint8_t flags,uint16_t timestamp_ms);
