#include "nv_config.h"
#include "nv_record.h"
#include "../BSP/board_config.h"
#include "../Protocol/proto_codec.h"
#include "../User/fixed_vqf.h"
#include <string.h>
/* D6 has 32 KB code Flash. Fast-mode pages are 256 bytes (WCH driver).
 * Link.ld excludes both pages. Never use standard 4 KB page erase here. */
#define NV_SLOT0 0x08007E00UL
#define NV_SLOT1 0x08007F00UL
nv_config_t nv_saved;
uint32_t nv_sequence,nv_write_errors;
static uint32_t active_slot;
static uint32_t page_buffer[64];
static bool decode(uint32_t address,nv_config_t *c,uint32_t *seq)
{
    return nv_record_decode((const uint8_t *)address,c,seq);
}
void nv_config_load(void)
{
    nv_config_t a,b; uint32_t sa=0,sb=0; bool va=decode(NV_SLOT0,&a,&sa),vb=decode(NV_SLOT1,&b,&sb);
    nv_sequence=nv_write_errors=0; active_slot=0;
    nv_saved.output_hz=HOST_STREAM_RATE_DEFAULT; nv_saved.uart.format=FORMAT_CUSTOM;
    nv_saved.uart.legacy_mode=0; nv_saved.uart.mask=FIELDS_ALL; nv_saved.filter_profile=1;
    acc_params_identity(&nv_saved.acc);
    if(va && (!vb || (int32_t)(sa-sb)>0)) { nv_saved=a; nv_sequence=sa; active_slot=NV_SLOT0; }
    else if(vb) { nv_saved=b; nv_sequence=sb; active_slot=NV_SLOT1; }
}
/* Bounded polls, including buffer-write busy. Hardware may stall code fetch
 * briefly during Flash operations; no interrupt handler performs these writes. */
static bool wait_flash(uint32_t bits)
{ uint32_t budget=2000000U; while((FLASH->STATR&bits) && --budget) {} return budget!=0; }
bool nv_config_save(const nv_config_t *c)
{
    uint8_t *p=(uint8_t *)page_buffer; uint32_t dest=active_slot==NV_SLOT0 ? NV_SLOT1 : NV_SLOT0;
    uint32_t irq,i; bool ok=true; nv_config_t checked; uint32_t sequence;
    if(!acc_params_valid(&c->acc)) return false;
    if(nv_config_equal(c,&nv_saved)) return true;
    memset(page_buffer,0xFF,sizeof(page_buffer));
    nv_record_encode(p,c,nv_sequence+1U);
    IWDG_ReloadCounter();
    __asm volatile("csrrc %0, 0x800, %1" : "=r"(irq) : "r"(8U) : "memory");
    FLASH_Unlock_Fast(); FLASH_ClearFlag(FLASH_FLAG_EOP|FLASH_FLAG_WRPRTERR);
    if(!wait_flash(3U)) ok=false;
    if(ok) {
        FLASH->CTLR|=1UL<<17; FLASH->ADDR=dest; FLASH->CTLR|=1UL<<6;
        ok=wait_flash(1U); FLASH->CTLR&=~(1UL<<17);
    }
    if(ok && !(FLASH->STATR&FLASH_FLAG_WRPRTERR)) {
        FLASH->CTLR|=1UL<<16;
        for(i=0;i<64 && ok;i++) { *(volatile uint32_t *)(dest+4*i)=page_buffer[i]; ok=wait_flash(2U); }
        if(ok) { FLASH->CTLR|=1UL<<21; ok=wait_flash(1U); }
        FLASH->CTLR&=~(1UL<<16);
    } else ok=false;
    if(FLASH->STATR&FLASH_FLAG_WRPRTERR) ok=false;
    FLASH_Lock_Fast(); FLASH_Lock();
    if(irq&8U) __asm volatile("csrs 0x800, %0" :: "r"(8U) : "memory");
    if(ok) ok=memcmp((const void *)dest,page_buffer,sizeof(page_buffer))==0 && decode(dest,&checked,&sequence);
    if(ok) { nv_saved=checked; nv_sequence=sequence; active_slot=dest; }
    else nv_write_errors++;
    return ok;
}
