#pragma once
/* Shared OTA memory map and record layouts: boot stub, app, host tests and
 * tools/ahrs_ota.py must agree. All integers little-endian.
 *
 * Physical 0x08000000.. == zero-wait execution alias 0x00000000..
 *   0x08000000-0x080003FF  boot stub (1 KB, never erased by stub or app OTA)
 *   0x08000400-0x08007DFF  app image (31232 B max), linked/executed at 0x00000400
 *   0x08007E00-0x08007FFF  NV config slots (never touched by OTA)
 *   0x08008000-0x080080FF  staging header page (valid header == update pending)
 *   0x08008100-0x0800FCFF  staged image (outside the 32 KB spec'd area, slow flash)
 */
#include <stdint.h>
#define OTA_FLASH_PHYS      0x08000000UL
#define OTA_PAGE            256UL
#define OTA_STUB_SIZE       0x00000400UL
#define OTA_APP_ALIAS       0x00000400UL
#define OTA_APP_PHYS        (OTA_FLASH_PHYS + OTA_APP_ALIAS)
#define OTA_NV_PHYS         0x08007E00UL
#define OTA_APP_MAX         (OTA_NV_PHYS - OTA_APP_PHYS)            /* 0x7A00 = 31232 */
#define OTA_STAGE_HDR_PHYS  0x08008000UL
#define OTA_STAGE_IMG_PHYS  (OTA_STAGE_HDR_PHYS + OTA_PAGE)         /* 0x08008100 */
#define OTA_STAGE_END_PHYS  (OTA_STAGE_IMG_PHYS + OTA_APP_MAX)      /* 0x0800FD00 */
#define OTA_ERASED_WORD     0xE339E339UL  /* CH32V203 erased flash read pattern */
#define OTA_MIN_IMAGE       0x200UL
#define OTA_MAX_CHUNK       56U

/* Staging header (first 28 bytes of 0x08008000):
 *  0 magic 'OTA1'  4 image size  8 image CRC32  12 version[12] (ASCII, NUL padded)
 * 24 CRC32 of bytes 0..23. CRC32 = IEEE/zlib (reflected 0xEDB88320, init/xorout ~0). */
#define OTA_HDR_MAGIC       0x3141544FUL
#define OTA_HDR_SIZE        28U
#define OTA_HDR_CRC_OFF     24U

/* App descriptor at image offset 0x100 (alias 0x00000500, right after the
 * app vector table): 0 magic 'CHAP'  4 image_end (alias address of the end
 * of the load image)  8 version[12]. */
#define OTA_DESC_MAGIC      0x50414843UL
#define OTA_DESC_OFFSET     0x100UL
#define OTA_DESC_SIZE       20U

static inline uint32_t ota_get_u32(const volatile uint8_t *p)
{ return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

/* Descriptor at image start `img` (any mapping) is consistent with `size`. */
static inline int ota_desc_ok(const volatile uint8_t *img, uint32_t size)
{
    const volatile uint8_t *d = img + OTA_DESC_OFFSET; uint32_t len;
    if(size < OTA_MIN_IMAGE || size > OTA_APP_MAX || ota_get_u32(d) != OTA_DESC_MAGIC) return 0;
    len = ota_get_u32(d + 4) - OTA_APP_ALIAS;
    return len >= OTA_MIN_IMAGE && len <= size && size - len < 4U;
}
