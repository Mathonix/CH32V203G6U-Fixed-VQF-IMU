#pragma once
#include <stdint.h>
#include <stdbool.h>
/* App-side OTA staging (AA55 0x40..0x44). Writes only 0x08008000..0x0800FCFF. */
uint8_t ota_command(uint8_t id, const uint8_t *payload, uint8_t length, uint16_t *detail);
bool ota_active(void);      /* session open: telemetry paused */
/* HAL, Storage/ota_flash.c on target; a fake in tests/ota_host_fake.c.
 * words==0: erase only (and check erased); else erase + program + read back. */
bool ota_hal_page(uint32_t phys, const uint32_t *words);
#ifdef OTA_HOST_TEST
const volatile uint8_t *ota_hal_mem(uint32_t phys);
#endif
#define OTA_ERR_SETTINGS   0x0701U  /* BEGIN needs settings mode */
#define OTA_ERR_PARAM      0x0702U  /* length / size / chunk shape */
#define OTA_ERR_STATE      0x0703U  /* no session or wrong phase */
#define OTA_ERR_OFFSET     0x0704U  /* not the next sequential offset */
#define OTA_ERR_FLASH      0x0705U  /* erase/program/read-back failed */
#define OTA_ERR_CRC        0x0706U  /* staged image CRC32 != BEGIN CRC32 */
#define OTA_ERR_NOT_VERIFIED 0x0707U/* COMMIT before a successful END */
#define OTA_ERR_IMAGE      0x0708U  /* no valid app descriptor in the image */
