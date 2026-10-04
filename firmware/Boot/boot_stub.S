/* CH32V203 OTA boot stub entry, linked at 0x00000000 (reset PC). No vectors:
 * the stub never enables interrupts; any trap parks in boot_trap. */
    .section .text.entry,"ax",@progbits
    .globl _start
_start:
    li   sp, 0x20002800          /* top of 10 KB SRAM */
    la   t0, boot_trap
    csrw mtvec, t0              /* direct mode, stub-local trap */
    j    stub_main
    .balign 4
boot_trap:
    j    boot_trap
