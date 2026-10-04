#include "../Boot/ota_layout.h"
#include "../BSP/board_config.h"
/* App descriptor at image offset 0x100 (alias 0x00000500), checked by the boot
 * stub before jumping and by OTA END before accepting a staged image. */
extern const char __app_image_end[];
typedef struct { uint32_t magic; const char *image_end; char version[12]; } app_desc_t;
__attribute__((section(".app_desc"), used)) const app_desc_t app_desc = { OTA_DESC_MAGIC, __app_image_end, FW_VERSION_TEXT };
