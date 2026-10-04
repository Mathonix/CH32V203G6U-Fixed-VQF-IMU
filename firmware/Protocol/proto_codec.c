#include "proto_codec.h"
#include <string.h>
#include <float.h>
typedef char ieee754_float_required[(sizeof(float)==4 && FLT_RADIX==2 && FLT_MANT_DIG==24 && FLT_MAX_EXP==128) ? 1 : -1];
uint16_t proto_get_u16(const uint8_t *p) { return (uint16_t)(p[0]|((uint16_t)p[1]<<8)); }
uint32_t proto_get_u32(const uint8_t *p) { return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24); }
void proto_put_u16(uint8_t *p,uint16_t v) { p[0]=(uint8_t)v; p[1]=(uint8_t)(v>>8); }
void proto_put_u32(uint8_t *p,uint32_t v)
{ p[0]=(uint8_t)v; p[1]=(uint8_t)(v>>8); p[2]=(uint8_t)(v>>16); p[3]=(uint8_t)(v>>24); }
void proto_put_float(uint8_t *p,float v) { uint32_t bits; memcpy(&bits,&v,4); proto_put_u32(p,bits); }
uint16_t proto_encode(uint8_t *dst,uint16_t capacity,uint8_t id,uint8_t seq,const uint8_t *payload,uint8_t length)
{
    if(!dst || length>PROTO_MAX_PAYLOAD || capacity<length+7U || (length && !payload)) return 0;
    dst[0]=0xAA; dst[1]=0x55; dst[2]=id; dst[3]=length; dst[4]=seq;
    if(length) memcpy(dst+5,payload,length);
    proto_put_u16(dst+5+length,proto_crc16(dst+2,(uint16_t)(3U+length)));
    return (uint16_t)(7U+length);
}
uint16_t proto_output(uint8_t *dst,uint16_t capacity,uint8_t seq,const output_config_t *c,
                      const float f[9],int16_t temp,uint8_t flags,uint16_t ms)
{
    uint8_t p[40]={0},n=0,i,id=0;
    if(!c || !f || c->format>FORMAT_LEGACY || c->legacy_mode>4 || (c->mask&~FIELDS_ALL)) return 0;
    if(c->format==FORMAT_LEGACY) {
        if(c->legacy_mode==1) {
            for(i=0;i<3;i++) proto_put_float(p+4*i,f[2-i]);
            p[12]=flags; proto_put_u16(p+14,ms); n=16; id=MSG_EULER;
        } else if(c->legacy_mode==2) {
            for(i=0;i<3;i++) proto_put_u16(p+2*i,(uint16_t)(int16_t)(f[2-i]*100.0f));
            proto_put_u16(p+6,(uint16_t)(int16_t)(f[8]*10.0f)); p[8]=flags;
            proto_put_u16(p+10,ms); n=12; id=MSG_COMPACT;
        } else if(c->legacy_mode==3) {
            for(i=0;i<3;i++) { proto_put_float(p+4*i,f[6+i]); proto_put_float(p+12+4*i,f[3+i]); }
            proto_put_u16(p+24,(uint16_t)temp); proto_put_u16(p+26,ms); n=28; id=MSG_IMU;
        } else {
            for(i=0;i<3;i++) proto_put_float(p+4*i,f[i]);
            n=12;
            if(c->legacy_mode==4) {
                proto_put_float(p+12,f[8]); proto_put_float(p+16,f[5]); proto_put_float(p+20,(float)temp/100.0f); n=24;
            }
        }
    } else {
        if(!c->mask) return 0;
        if(c->format==FORMAT_CUSTOM) { proto_put_u16(p,c->mask); proto_put_u16(p+2,ms); n=4; id=MSG_SELECTED_DATA; }
        for(i=0;i<9;i++) if(c->mask&(1U<<i)) { proto_put_float(p+n,f[i]); n+=4; }
    }
    if(id) return proto_encode(dst,capacity,id,seq,p,n);
    if(!dst || capacity<n+4U) return 0;
    memcpy(dst,p,n); dst[n]=dst[n+1]=0; dst[n+2]=0x80; dst[n+3]=0x7F;
    return (uint16_t)(n+4U);
}
