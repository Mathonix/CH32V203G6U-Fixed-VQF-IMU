#include "nv_record.h"
#include "../Protocol/proto_codec.h"
#include <string.h>
static float get_float(const uint8_t *p)
{ uint32_t v=proto_get_u32(p); float f; memcpy(&f,&v,4); return f; }
bool nv_record_decode(const uint8_t *p,nv_config_t *c,uint32_t *seq)
{
    uint16_t ver=proto_get_u16(p+4),len=proto_get_u16(p+6); unsigned i;
    if(proto_get_u32(p)!=0x43485241UL ||
       !((ver==1 && len==24) || (ver==2 && len==NV_RECORD_BYTES)) ||
       proto_get_u16(p+len-2)!=proto_crc16(p,len-2)) return false;
    memset(c,0,sizeof(*c));
    c->output_hz=proto_get_u16(p+12); c->uart.format=p[14]; c->uart.legacy_mode=p[15];
    c->uart.mask=proto_get_u16(p+16); c->filter_profile=p[18]; *seq=proto_get_u32(p+8);
    acc_params_identity(&c->acc);
    if(ver==2) {
        c->acc.valid=p[19];
        for(i=0;i<3;i++) { c->acc.bias_g[i]=get_float(p+20+4*i); c->acc.scale[i]=get_float(p+32+4*i); }
    }
    return c->output_hz && c->output_hz<=2000 && 2000%c->output_hz==0 &&
        c->uart.format<=2 && c->uart.legacy_mode<=4 && !(c->uart.mask&~FIELDS_ALL) &&
        c->filter_profile<4 && acc_params_valid(&c->acc);
}
void nv_record_encode(uint8_t *p,const nv_config_t *c,uint32_t seq)
{
    unsigned i; memset(p,0,NV_RECORD_BYTES);
    proto_put_u32(p,0x43485241UL); proto_put_u16(p+4,2); proto_put_u16(p+6,NV_RECORD_BYTES);
    proto_put_u32(p+8,seq); proto_put_u16(p+12,c->output_hz);
    p[14]=c->uart.format; p[15]=c->uart.legacy_mode; proto_put_u16(p+16,c->uart.mask);
    p[18]=c->filter_profile; p[19]=c->acc.valid;
    for(i=0;i<3;i++) { proto_put_float(p+20+4*i,c->acc.bias_g[i]); proto_put_float(p+32+4*i,c->acc.scale[i]); }
    proto_put_u16(p+46,proto_crc16(p,46));
}
bool nv_config_equal(const nv_config_t *a,const nv_config_t *b)
{
    uint8_t x[NV_RECORD_BYTES],y[NV_RECORD_BYTES];
    nv_record_encode(x,a,0); nv_record_encode(y,b,0); return memcmp(x,y,sizeof(x))==0;
}
