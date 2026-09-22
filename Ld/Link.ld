ENTRY( _start )

__stack_size = 2048;

PROVIDE( _stack_size = __stack_size );


MEMORY
{  
/* CH32V20x_D6 - CH32V203F6-CH32V203G6-CH32V203C6 */

	/* 0x00000000..0x00007FFF: 32 KB zero-wait code Flash. */
	FLASH_FAST (rx) : ORIGIN = 0x00000000, LENGTH = 32K
	RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 10K


/* CH32V20x_D6 - CH32V203K8-CH32V203C8-CH32V203G8-CH32V203F8 */
/*
	FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 64K
	RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 20K
*/ 
  
/* CH32V20x_D8 - CH32V203RB
   CH32V20x_D8W - CH32V208x
   FLASH + RAM supports the following configuration
   FLASH-128K + RAM-64K
   FLASH-144K + RAM-48K
   FLASH-160K + RAM-32K
*/
/*
	FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 160K
	RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 32K
*/

}


SECTIONS
{

	.init :
	{
		_sinit = .;
		. = ALIGN(4);
		KEEP(*(SORT_NONE(.init)))
		. = ALIGN(4);
		_einit = .;
	} >FLASH_FAST AT>FLASH_FAST

  .vector :
  {
      *(.vector);
	  . = ALIGN(64);
  } >FLASH_FAST AT>FLASH_FAST

	.text :
	{
		. = ALIGN(4);
		*(.text)
		*(.text.*)
		*(.rodata)
		*(.rodata*)
		*(.gnu.linkonce.t.*)
		. = ALIGN(4);
	} >FLASH_FAST AT>FLASH_FAST 

	/* One-time initialization and other cold paths execute from the
	 * non-zero-wait Flash bank, preserving the complete 32 KB fast bank
	 * for the 1 kHz sensor/VQF/CAN/UART path. */
	.slowtext :
	{
		. = ALIGN(4);
		__slowtext_start = .;
		KEEP(*(.slowtext))
		KEEP(*(.slowtext.*))
		KEEP(*(.slowrodata))
		KEEP(*(.slowrodata.*))
		. = ALIGN(4);
		__slowtext_end = .;
	} >FLASH_FAST AT>FLASH_FAST

	.fini :
	{
		KEEP(*(SORT_NONE(.fini)))
		. = ALIGN(4);
	} >FLASH_FAST AT>FLASH_FAST

	PROVIDE( _etext = . );
	PROVIDE( _eitcm = . );	

	.preinit_array  :
	{
	  PROVIDE_HIDDEN (__preinit_array_start = .);
	  KEEP (*(.preinit_array))
	  PROVIDE_HIDDEN (__preinit_array_end = .);
	} >FLASH_FAST AT>FLASH_FAST 
	
	.init_array     :
	{
	  PROVIDE_HIDDEN (__init_array_start = .);
	  KEEP (*(SORT_BY_INIT_PRIORITY(.init_array.*) SORT_BY_INIT_PRIORITY(.ctors.*)))
	  KEEP (*(.init_array EXCLUDE_FILE (*crtbegin.o *crtbegin?.o *crtend.o *crtend?.o ) .ctors))
	  PROVIDE_HIDDEN (__init_array_end = .);
	} >FLASH_FAST AT>FLASH_FAST 
	
	.fini_array     :
	{
	  PROVIDE_HIDDEN (__fini_array_start = .);
	  KEEP (*(SORT_BY_INIT_PRIORITY(.fini_array.*) SORT_BY_INIT_PRIORITY(.dtors.*)))
	  KEEP (*(.fini_array EXCLUDE_FILE (*crtbegin.o *crtbegin?.o *crtend.o *crtend?.o ) .dtors))
	  PROVIDE_HIDDEN (__fini_array_end = .);
	} >FLASH_FAST AT>FLASH_FAST 
	
	.ctors          :
	{
	  /* gcc uses crtbegin.o to find the start of
	     the constructors, so we make sure it is
	     first.  Because this is a wildcard, it
	     doesn't matter if the user does not
	     actually link against crtbegin.o; the
	     linker won't look for a file to match a
	     wildcard.  The wildcard also means that it
	     doesn't matter which directory crtbegin.o
	     is in.  */
	  KEEP (*crtbegin.o(.ctors))
	  KEEP (*crtbegin?.o(.ctors))
	  /* We don't want to include the .ctor section from
	     the crtend.o file until after the sorted ctors.
	     The .ctor section from the crtend file contains the
	     end of ctors marker and it must be last */
	  KEEP (*(EXCLUDE_FILE (*crtend.o *crtend?.o ) .ctors))
	  KEEP (*(SORT(.ctors.*)))
	  KEEP (*(.ctors))
	} >FLASH_FAST AT>FLASH_FAST 
	
	.dtors          :
	{
	  KEEP (*crtbegin.o(.dtors))
	  KEEP (*crtbegin?.o(.dtors))
	  KEEP (*(EXCLUDE_FILE (*crtend.o *crtend?.o ) .dtors))
	  KEEP (*(SORT(.dtors.*)))
	  KEEP (*(.dtors))
	} >FLASH_FAST AT>FLASH_FAST 

	.dalign :
	{
		. = ALIGN(4);
		PROVIDE(_data_vma = .);
	} >RAM AT>FLASH_FAST	

	.dlalign :
	{
		. = ALIGN(4); 
		PROVIDE(_data_lma = .);
	} >FLASH_FAST AT>FLASH_FAST

	.data :
	{
    	*(.gnu.linkonce.r.*)
    	*(.data .data.*)
    	*(.gnu.linkonce.d.*)
		. = ALIGN(8);
    	PROVIDE( __global_pointer$ = . + 0x800 );
    	*(.sdata .sdata.*)
		*(.sdata2.*)
    	*(.gnu.linkonce.s.*)
    	. = ALIGN(8);
    	*(.srodata.cst16)
    	*(.srodata.cst8)
    	*(.srodata.cst4)
    	*(.srodata.cst2)
    	*(.srodata .srodata.*)
    	. = ALIGN(4);
		PROVIDE( _edata = .);
	} >RAM AT>FLASH_FAST

	.bss :
	{
		. = ALIGN(4);
		PROVIDE( _sbss = .);
  	    *(.sbss*)
        *(.gnu.linkonce.sb.*)
		*(.bss*)
     	*(.gnu.linkonce.b.*)		
		*(COMMON*)
		. = ALIGN(4);
		PROVIDE( _ebss = .);
	} >RAM AT>FLASH_FAST

	PROVIDE( _end = _ebss);
	PROVIDE( end = . );

    .stack ORIGIN(RAM) + LENGTH(RAM) - __stack_size :
    {
        PROVIDE( _heap_end = . );   
        . = ALIGN(4);
        PROVIDE(_susrstack = . );
        . = . + __stack_size;
        PROVIDE( _eusrstack = .);
    } >RAM 

}




ASSERT(SIZEOF(.text) + SIZEOF(.init) + SIZEOF(.vector) <= LENGTH(FLASH_FAST), "zero-wait Flash overflow")
ASSERT(__slowtext_end <= ORIGIN(FLASH_FAST) + LENGTH(FLASH_FAST), "code Flash overflow")

