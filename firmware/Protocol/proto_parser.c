#include "proto_parser.h"
#include "proto_codec.h"
#include <string.h>
static void discard(proto_parser_t *p,uint16_t n)
{ p->used=(uint16_t)(p->used-n); memmove(p->data,p->data+n,p->used); }
static void parse(proto_parser_t *p)
{
    uint16_t size,total;
    while(p->used) {
        if(p->data[0]!=0xAA) { p->parse_errors++; discard(p,1); continue; }
        if(p->used<2) return;
        if(p->data[1]!=0x55) { p->parse_errors++; discard(p,1); continue; }
        if(p->used<4) return;
        size=p->data[3];
        if(size>PROTO_MAX_PAYLOAD) {
            p->parse_errors++; discard(p,1); continue;
        }
        total=(uint16_t)(size+7U);
        if(p->used<total) return;
        if(proto_crc16(p->data+2,(uint16_t)(size+3U))!=proto_get_u16(p->data+5+size)) {
            p->crc_errors++; discard(p,1); continue;
        }
        p->frames++;
        if(p->callback) p->callback(p->data[2],p->data[4],p->data+5,(uint8_t)size);
        discard(p,total);
    }
}
void proto_parser_init(proto_parser_t *p,proto_frame_fn callback)
{ memset(p,0,sizeof(*p)); p->callback=callback; }
void proto_parser_byte(proto_parser_t *p,uint8_t byte,uint32_t now_ms)
{
    proto_parser_timeout(p,now_ms);
    /* Discarded binary bytes never participate in ASCII recognition. */
    if(!p->used && byte!=0xAA) {
        static const char text[]="vofa";
        uint8_t c=byte;
        if(c>='A' && c<='Z') c=(uint8_t)(c+('a'-'A'));
        p->vofa_match=(c==(uint8_t)text[p->vofa_match]) ? p->vofa_match+1U : (c=='v' ? 1U : 0U);
        if(p->vofa_match==4) { p->vofa_match=0; if(p->vofa_callback) p->vofa_callback(); }
        return;
    }
    if(byte==0xAA) p->vofa_match=0;
    if(p->used==PROTO_MAX_FRAME) { p->parse_errors++; discard(p,1); }
    p->data[p->used++]=byte; p->last_byte_ms=now_ms; parse(p);
}
void proto_parser_timeout(proto_parser_t *p,uint32_t now_ms)
{
    if(p->used && (uint32_t)(now_ms-p->last_byte_ms)>=100U) {
        /* Recover a valid nested frame even when a damaged length claimed more bytes. */
        p->parse_errors++; discard(p,1); parse(p);
        if(p->used) { p->parse_errors++; p->used=0; }
    }
}
