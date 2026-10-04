/* Boot stub: 1 KB at the reset address, no static RAM. */
ENTRY(_start)
MEMORY
{
    STUB (rx) : ORIGIN = 0x00000000, LENGTH = 0x400
    RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 10K
}
SECTIONS
{
    .text :
    {
        KEEP(*(.text.entry))
        *(.text .text.*)
        *(.rodata .rodata.* .srodata .srodata.*)
        . = ALIGN(4);
    } >STUB
    .data :
    {
        *(.data .data.* .sdata .sdata.* .bss .bss.* .sbss .sbss.* COMMON)
    } >RAM AT>STUB
}
ASSERT(SIZEOF(.data) == 0, "boot stub must not use static RAM")
ASSERT(_start == 0, "stub entry must be at the reset address")
