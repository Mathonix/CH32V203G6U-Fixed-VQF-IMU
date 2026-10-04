#include "ota_stage.h"
#include "../Boot/ota_layout.h"
#include "../BSP/board_config.h"
/* Same fast-page sequence as nv_config_save (FLASH_ErasePage_Fast /
 * FLASH_ProgramPage_Fast). Executes from zero-wait flash; target restricted
 * to the staging window, so the stub, the app and the NV pages are unreachable. */
static bool wait_flash(uint32_t bits)
{ uint32_t budget = 2000000U; while((FLASH->STATR & bits) && --budget) {} return budget != 0; }
bool ota_hal_page(uint32_t d, const uint32_t *w)
{
    uint32_t irq, i; bool ok;
    if((d & (OTA_PAGE - 1U)) || d < OTA_STAGE_HDR_PHYS || d > OTA_STAGE_END_PHYS - OTA_PAGE) return false;
    IWDG_ReloadCounter();
    __asm volatile("csrrc %0, 0x800, %1" : "=r"(irq) : "r"(8U) : "memory");
    FLASH_Unlock_Fast(); FLASH_ClearFlag(FLASH_FLAG_EOP | FLASH_FLAG_WRPRTERR);
    ok = wait_flash(3U);
    if(ok) { FLASH->CTLR |= 1UL << 17; FLASH->ADDR = d; FLASH->CTLR |= 1UL << 6; ok = wait_flash(1U); FLASH->CTLR &= ~(1UL << 17); }
    if(ok && w && !(FLASH->STATR & FLASH_FLAG_WRPRTERR)) {
        FLASH->CTLR |= 1UL << 16;
        for(i = 0; i < 64 && ok; i++) { *(volatile uint32_t *)(d + 4U * i) = w[i]; ok = wait_flash(2U); }
        if(ok) { FLASH->CTLR |= 1UL << 21; ok = wait_flash(1U); }
        FLASH->CTLR &= ~(1UL << 16);
    }
    if(FLASH->STATR & FLASH_FLAG_WRPRTERR) ok = false;
    FLASH_Lock_Fast(); FLASH_Lock();
    if(irq & 8U) __asm volatile("csrs 0x800, %0" :: "r"(8U) : "memory");
    for(i = 0; i < 64 && ok; i++) ok = ((volatile uint32_t *)d)[i] == (w ? w[i] : OTA_ERASED_WORD);
    return ok;
}
