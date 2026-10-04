#pragma once
#include "proto_defs.h"
typedef void (*proto_frame_fn)(uint8_t id,uint8_t seq,const uint8_t *payload,uint8_t length);
typedef struct {
    uint8_t data[PROTO_MAX_FRAME];
    uint16_t used;
    uint32_t last_byte_ms,frames,parse_errors,crc_errors;
    proto_frame_fn callback;
    void (*vofa_callback)(void);
    uint8_t vofa_match;
} proto_parser_t;
void proto_parser_init(proto_parser_t *parser,proto_frame_fn callback);
void proto_parser_byte(proto_parser_t *parser,uint8_t byte,uint32_t now_ms);
void proto_parser_timeout(proto_parser_t *parser,uint32_t now_ms);
