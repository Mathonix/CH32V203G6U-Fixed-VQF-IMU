/* CH32V203 OTA boot stub (runs from zero-wait flash at 0x00000000, HSI 8 MHz).
 *
 * 1. If the staging header at 0x08008000 is valid (== update pending), the
 *    staged image CRC32 matches it and the image carries an app descriptor:
 *    copy it page by page (fast 256 B erase/program) into 0x08000400.. until
 *    the app CRC32 matches (max 3 attempts), then erase the header page.
 *    Staging stays intact until the app is verified, so a power cut at any
 *    point redoes or finishes the copy on the next boot.
 * 2. Jump to 0x00000400 if the app descriptor is plausible; otherwise blink
 *    PA9 forever (no runnable app; recover with the debugger).
 * Never erases 0x08000000-0x080003FF or the NV pages 0x08007E00/0x08007F00.
 * Uses no static RAM; IWDG (if a hardware-option watchdog runs) is fed. */
#include "ota_layout.h"
#include "../Utils/crc32.h"

#ifdef BOOT_HOST_TEST
const volatile uint8_t *boot_mem(uint32_t phys);
uint32_t boot_rd32(uint32_t phys);
#define RD32(a) boot_rd32(a)
int boot_write_page(uint32_t dst, const uint32_t *src);
int boot_erase_page(uint32_t dst);
void boot_feed(void);
#define MEM(a) boot_mem(a)
#else
#define MEM(a) ((const volatile uint8_t *)(a))
#define RD32(a) (*(const volatile uint32_t *)(a))
#define R(a) (*(volatile uint32_t *)(a))
#define FL_KEYR     0x40022004UL
#define FL_STATR    0x4002200CUL
#define FL_CTLR     0x40022010UL
#define FL_ADDR     0x40022014UL
#define FL_MODEKEYR 0x40022024UL
#define CR_PAGE_PG  (1UL << 16)
#define CR_PAGE_ER  (1UL << 17)
#define CR_PG_STRT  (1UL << 21)
#define CR_STRT     (1UL << 6)

static void boot_feed(void) { R(0x40003000UL) = 0xAAAAUL; }
static int fl_wait(uint32_t bits) { uint32_t n = 0x400000UL; while((R(FL_STATR) & bits) && --n) {} return n != 0; }
static int app_page(uint32_t d) { return !(d & (OTA_PAGE - 1U)) && d >= OTA_APP_PHYS && d + OTA_PAGE <= OTA_NV_PHYS; }
static int fl_erase(uint32_t d)
{
    int ok;
    if(!app_page(d) && d != OTA_STAGE_HDR_PHYS) return 0;  /* stub + NV pages unreachable */
    boot_feed(); R(FL_STATR) = 0x30U;
    R(FL_CTLR) |= CR_PAGE_ER; R(FL_ADDR) = d; R(FL_CTLR) |= CR_STRT;
    ok = fl_wait(1U); R(FL_CTLR) &= ~CR_PAGE_ER;
    return ok && !(R(FL_STATR) & 0x10U);
}
static int boot_erase_page(uint32_t d) { return d == OTA_STAGE_HDR_PHYS && fl_erase(d); }
static __attribute__((noinline)) int boot_write_page(uint32_t d, const uint32_t *s)
{
    int ok, i;
    if(!app_page(d) || !fl_erase(d)) return 0;
    R(FL_CTLR) |= CR_PAGE_PG; ok = fl_wait(3U);
    for(i = 0; i < 64 && ok; i++) { R(d + 4U * i) = s[i]; ok = fl_wait(2U); }
    if(ok) { R(FL_CTLR) |= CR_PG_STRT; ok = fl_wait(1U); }
    R(FL_CTLR) &= ~CR_PAGE_PG;
    if(R(FL_STATR) & 0x10U) ok = 0;
    for(i = 0; i < 64 && ok; i++) ok = R(d + 4U * i) == s[i];
    return ok;
}
#endif

static __attribute__((noinline)) uint32_t crc_region(uint32_t a, uint32_t n)
{
    uint32_t c = 0, k;
    while(n) { k = n > OTA_PAGE ? OTA_PAGE : n; boot_feed(); c = crc32_update(c, MEM(a), k); a += k; n -= k; }
    return c;
}

/* Image at physical `img` carries a descriptor consistent with `size` (unsigned range tricks keep the stub small). */
static int desc_ok(uint32_t img, uint32_t size)
{
    uint32_t len = RD32(img + OTA_DESC_OFFSET + 4U) - OTA_APP_ALIAS;
    return RD32(img + OTA_DESC_OFFSET) == OTA_DESC_MAGIC && size - OTA_MIN_IMAGE <= OTA_APP_MAX - OTA_MIN_IMAGE &&
           len - OTA_MIN_IMAGE <= size - OTA_MIN_IMAGE && size - len < 4U;
}

/* 1: start the app, 0: no runnable app. */
int boot_decide(void)
{
    uint32_t size = RD32(OTA_STAGE_HDR_PHYS + 4U), crc = RD32(OTA_STAGE_HDR_PHYS + 8U), p, i, buf[64], w;
    int tries = 0;
    if(RD32(OTA_STAGE_HDR_PHYS) == OTA_HDR_MAGIC && !(size & 3U) &&
       crc32_update(0, MEM(OTA_STAGE_HDR_PHYS), OTA_HDR_CRC_OFF) == RD32(OTA_STAGE_HDR_PHYS + OTA_HDR_CRC_OFF) &&
       desc_ok(OTA_STAGE_IMG_PHYS, size) && crc_region(OTA_STAGE_IMG_PHYS, size) == crc) {
        while(crc_region(OTA_APP_PHYS, size) != crc) {
            if(tries++ == 3) return 0;          /* app incomplete: never run it; staging kept */
            for(p = 0; p < size; p += OTA_PAGE) {
                for(i = 0; i < 64; i++) buf[i] = RD32(OTA_STAGE_IMG_PHYS + p + 4U * i);
                boot_write_page(OTA_APP_PHYS + p, buf);
            }
        }
        boot_erase_page(OTA_STAGE_HDR_PHYS);    /* clear pending only after the app CRC matched */
    }
    w = RD32(OTA_APP_PHYS);
    return w != OTA_ERASED_WORD && w != 0xFFFFFFFFUL &&
           desc_ok(OTA_APP_PHYS, RD32(OTA_APP_PHYS + OTA_DESC_OFFSET + 4U) - OTA_APP_ALIAS);
}
#ifndef BOOT_HOST_TEST
void stub_main(void) __attribute__((noreturn));
void stub_main(void)
{
    int run;
    uint32_t n;
    /* Keep MCU TX high throughout staging verification/copy. WCH-Link
     * traffic with a floating PA2 has reproduced target resets. Preload
     * output latches before configuring PA2, avoiding a low/break pulse;
     * PA3 is pulled up and the app later owns USART2 pin configuration. */
    R(0x40021018UL) |= 1UL << 2;               /* GPIOA clock */
    R(0x40010810UL) = (1UL << 2) | (1UL << 3); /* BSHR: PA2/PA3 latch high */
    R(0x40010800UL) = (R(0x40010800UL) & ~0xFF00UL) | 0x8200UL;
    boot_feed();
    R(FL_KEYR) = 0x45670123UL; R(FL_KEYR) = 0xCDEF89ABUL;
    R(FL_MODEKEYR) = 0x45670123UL; R(FL_MODEKEYR) = 0xCDEF89ABUL;
    run = boot_decide();
    R(FL_CTLR) |= 0x8080UL;                    /* FLOCK | LOCK */
    if(run) __asm volatile("jr %0" :: "r"(OTA_APP_ALIAS));
    R(0x40010804UL) = (R(0x40010804UL) & ~0xF0UL) | 0x20UL;  /* PA9 push-pull 2 MHz */
    for(;;) {
        R(0x4001080CUL) ^= 1UL << 9;
        for(n = 0; n < 300000UL; n++) boot_feed();
    }
}
#endif


