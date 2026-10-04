#include "ota_stage.h"
#include "../Boot/ota_layout.h"
#include "../Utils/crc32.h"
#include "../Protocol/proto_defs.h"
#include <string.h>
#ifdef OTA_HOST_TEST
#define MEM(a) ota_hal_mem(a)
#else
#define MEM(a) ((const volatile uint8_t *)(a))
#endif
enum { OTA_IDLE, OTA_RECEIVING, OTA_VERIFIED, OTA_COMMITTED };
static uint8_t state, last_len;
static uint32_t img_size, img_crc, next_off, last_off;
static uint8_t version[12];
static uint32_t page[64];

bool ota_active(void) { return state != OTA_IDLE; }
static uint32_t get32(const uint8_t *p) { return ota_get_u32(p); }
static void put32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static uint32_t crc_stage(uint32_t n) { return crc32_update(0, MEM(OTA_STAGE_IMG_PHYS), n); }
/* Program the RAM page buffer at the staging page holding `off`, then reset it. */
static bool flush(uint32_t off)
{
    bool ok = ota_hal_page(OTA_STAGE_IMG_PHYS + (off & ~(OTA_PAGE - 1U)), page);
    memset(page, 0xFF, sizeof(page)); return ok;
}
static uint8_t fail(uint16_t *detail, uint16_t code) { *detail = code; return ACK_EXEC_FAILED; }

uint8_t ota_command(uint8_t id, const uint8_t *p, uint8_t len, uint16_t *detail)
{
    uint32_t off, n, i; uint8_t *b = (uint8_t *)page;
    *detail = 0;
    switch(id) {
    case CMD_OTA_BEGIN:                     /* size:u32 crc32:u32 version[12] */
        if(len != 20 || get32(p) < OTA_MIN_IMAGE || get32(p) > OTA_APP_MAX || (get32(p) & 3U)) { *detail = OTA_ERR_PARAM; return ACK_INVALID_PARAM; }
        state = OTA_IDLE;
        if(!ota_hal_page(OTA_STAGE_HDR_PHYS, 0)) return fail(detail, OTA_ERR_FLASH);   /* drop any older pending update */
        img_size = get32(p); img_crc = get32(p + 4); memcpy(version, p + 8, sizeof(version));
        next_off = last_off = 0; last_len = 0; memset(page, 0xFF, sizeof(page)); state = OTA_RECEIVING;
        return ACK_SUCCESS;
    case CMD_OTA_WRITE:                     /* offset:u32 data[4..56], multiple of 4, within one 256 B page */
        if(len < 8 || len > 4U + OTA_MAX_CHUNK || (len & 3U)) { *detail = OTA_ERR_PARAM; return ACK_INVALID_PARAM; }
        if(state != OTA_RECEIVING) return fail(detail, OTA_ERR_STATE);
        off = get32(p); n = len - 4U;
        if(last_len && off == last_off && n == last_len && off + n == next_off) {
            /* Repeat of the last chunk (lost ACK): accept only identical data. */
            const volatile uint8_t *s = (next_off & (OTA_PAGE - 1U)) ? (const volatile uint8_t *)b + (off & (OTA_PAGE - 1U)) : MEM(OTA_STAGE_IMG_PHYS + off);
            for(i = 0; i < n; i++) if(s[i] != p[4 + i]) return fail(detail, OTA_ERR_OFFSET);
            return ACK_SUCCESS;
        }
        if(off != next_off || n > img_size - off || (off & (OTA_PAGE - 1U)) + n > OTA_PAGE) return fail(detail, OTA_ERR_OFFSET);
        memcpy(b + (off & (OTA_PAGE - 1U)), p + 4, n); next_off += n; last_off = off; last_len = (uint8_t)n;
        if(!(next_off & (OTA_PAGE - 1U)) && !flush(off)) { state = OTA_IDLE; return fail(detail, OTA_ERR_FLASH); }
        return ACK_SUCCESS;
    case CMD_OTA_END:
        if(len) { *detail = OTA_ERR_PARAM; return ACK_INVALID_PARAM; }
        if(state == OTA_VERIFIED) return ACK_SUCCESS;
        if(state != OTA_RECEIVING) return fail(detail, OTA_ERR_STATE);
        if(next_off != img_size) return fail(detail, OTA_ERR_OFFSET);
        state = OTA_IDLE;
        if((next_off & (OTA_PAGE - 1U)) && !flush(next_off)) return fail(detail, OTA_ERR_FLASH);
        if(crc_stage(img_size) != img_crc) return fail(detail, OTA_ERR_CRC);
        if(!ota_desc_ok(MEM(OTA_STAGE_IMG_PHYS), img_size)) return fail(detail, OTA_ERR_IMAGE);
        state = OTA_VERIFIED; return ACK_SUCCESS;
    case CMD_OTA_COMMIT:                    /* writes the header == pending; caller resets after the ACK */
        if(len) { *detail = OTA_ERR_PARAM; return ACK_INVALID_PARAM; }
        if(state == OTA_COMMITTED) return ACK_SUCCESS;
        if(state != OTA_VERIFIED) return fail(detail, OTA_ERR_NOT_VERIFIED);
        memset(page, 0xFF, sizeof(page));
        put32(b, OTA_HDR_MAGIC); put32(b + 4, img_size); put32(b + 8, img_crc); memcpy(b + 12, version, sizeof(version));
        put32(b + OTA_HDR_CRC_OFF, crc32_update(0, b, OTA_HDR_CRC_OFF));
        state = OTA_IDLE;
        if(!ota_hal_page(OTA_STAGE_HDR_PHYS, page)) return fail(detail, OTA_ERR_FLASH);
        state = OTA_COMMITTED; return ACK_SUCCESS;
    case CMD_OTA_ABORT:                     /* also cancels a committed-but-not-yet-reset update */
        if(len) { *detail = OTA_ERR_PARAM; return ACK_INVALID_PARAM; }
        state = OTA_IDLE;
        return ota_hal_page(OTA_STAGE_HDR_PHYS, 0) ? ACK_SUCCESS : fail(detail, OTA_ERR_FLASH);
    default:
        return ACK_UNKNOWN_CMD;
    }
}
