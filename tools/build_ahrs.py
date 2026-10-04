"""Reproducible real/mock builds without modifying IDE-generated makefiles."""
import argparse
import os
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--mock',action='store_true')
parser.add_argument('--lto',action=argparse.BooleanOptionalAction,default=True,help='Whole-program size optimization')
parser.add_argument('--opt',default='z',choices=('s','z'))
parser.add_argument('--toolchain',default=os.environ.get('RISCV_GCC_BIN',r'D:\MounRiverStudio\MounRiver_Studio2\resources\app\resources\win32\components\WCH\Toolchain\RISC-V Embedded GCC12\bin'))
parser.add_argument('--fw-version',help='Override FW_VERSION_TEXT (exactly 9 ASCII chars), e.g. a version-bumped OTA test image')
parser.add_argument('--out',help='Output directory (default obj/ahrs_real or obj/ahrs_mock)')
args=parser.parse_args()
if args.fw_version is not None and (len(args.fw_version)!=9 or not args.fw_version.isascii() or not args.fw_version.isalnum()):
    parser.error('--fw-version must be 9 ASCII letters/digits')
tool=Path(args.toolchain)
prefix=next((p for p in ('riscv-none-embed','riscv-wch-elf','riscv32-wch-elf') if (tool/(p+'-gcc.exe')).exists()),None)
if not prefix: raise FileNotFoundError('WCH RISC-V compiler not found')
out=Path(args.out).resolve() if args.out else root/'obj'/('ahrs_mock' if args.mock else 'ahrs_real')
out.mkdir(parents=True,exist_ok=True)
sources=[root/'Startup/startup_ch32v20x_D6.S']
sources += [root/'User'/f for f in ('main.c','fixed_vqf.c','ch32v20x_it.c','system_ch32v20x.c')]
vendor_modules=('can','dma','flash','gpio','iwdg','misc','rcc','spi','tim','usart')
sources += [root/'Peripheral/src'/f'ch32v20x_{name}.c' for name in vendor_modules]
for directory in ('Debug','Core','App','BSP','Drivers','Protocol','Services','Storage','Transport','Utils'):
    sources += sorted((root/directory).glob('*.c'))
common=['-march=rv32imacxw','-mabi=ilp32','-msmall-data-limit=8','-msave-restore','-O'+args.opt,'-fsigned-char','-ffunction-sections','-fdata-sections','-fno-common','-g']
if args.lto: common += ['-flto']
includes=[f'-I{root/d}' for d in ('Debug','Core','User','Peripheral/inc')]
objects=[]
for source in sources:
    obj=out/source.relative_to(root).with_suffix('.o'); obj.parent.mkdir(parents=True,exist_ok=True)
    cmd=[str(tool/(prefix+'-gcc.exe')),*common,*includes]
    if args.mock: cmd += ['-DENABLE_SENSOR_MOCK=1']
    if args.fw_version: cmd += [f'-DFW_VERSION_TEXT="{args.fw_version}"']
    if source.suffix=='.c':
        cmd += ['-std=gnu99','-Wall','-Wextra','-Wuninitialized']
        if source.relative_to(root).parts[0] in ('Peripheral','Core','Debug'):
            cmd += ['-Wno-unused-parameter'] # Vendor API signatures have intentionally unused parameters.
    subprocess.run([*cmd,'-c',str(source),'-o',str(obj)],check=True)
    objects.append(str(obj))
elf=out/'CH32_AHRS.elf'
subprocess.run([str(tool/(prefix+'-gcc.exe')),*common,'-T',str(root/'Ld/Link.ld'),'-nostartfiles','-Xlinker','--gc-sections','--specs=nano.specs','--specs=nosys.specs',f'-Wl,-Map,{out / "CH32_AHRS.map"}','-o',str(elf),*objects,'-lm'],check=True)
objcopy=str(tool/(prefix+'-objcopy.exe'))
subprocess.run([str(tool/(prefix+'-size.exe')),str(elf)],check=True)
# OTA boot stub (Boot/): 1 KB at 0x0, no static RAM. The app is linked at 0x400.
stub_elf=out/'boot_stub.elf'
subprocess.run([str(tool/(prefix+'-gcc.exe')),'-march=rv32imac','-mabi=ilp32','-Os','-msmall-data-limit=0','-msave-restore',
                '-fno-inline-functions-called-once','-ffreestanding','-ffunction-sections','-fno-common','-Wall','-Wextra','-g',
                '-nostdlib','-nostartfiles','-Wl,--gc-sections','-T',str(root/'Boot/boot_stub.ld'),f'-Wl,-Map,{out/"boot_stub.map"}',
                str(root/'Boot/boot_stub.S'),str(root/'Boot/boot_stub.c'),str(root/'Utils/crc32.c'),'-lgcc','-o',str(stub_elf)],check=True)
subprocess.run([objcopy,'-O','binary',str(stub_elf),str(out/'boot_stub.bin')],check=True)
subprocess.run([objcopy,'-O','binary',str(elf),str(out/'CH32_AHRS_app.bin')],check=True)
symbols={l.split()[-1]:int(l.split()[0],16) for l in subprocess.run([str(tool/(prefix+'-nm.exe')),str(elf)],capture_output=True,text=True,check=True).stdout.splitlines() if len(l.split())==3}
stub=(out/'boot_stub.bin').read_bytes(); app=(out/'CH32_AHRS_app.bin').read_bytes()
APP_BASE,NV_BASE=0x400,0x7E00
if symbols.get('_start')!=APP_BASE or symbols.get('app_desc')!=APP_BASE+0x100: raise SystemExit('app not linked at the OTA base')
if len(stub)>APP_BASE: raise SystemExit(f'boot stub {len(stub)} B exceeds {APP_BASE} B')
if symbols['__app_image_end']-APP_BASE!=len(app) or APP_BASE+len(app)>NV_BASE: raise SystemExit('app image size mismatch')
full=stub+b'\xff'*(APP_BASE-len(stub))+app
(out/'CH32_AHRS_full.bin').write_bytes(full)
# Debugger image (stub + app). CH32_AHRS.hex is the full image, not the bare ELF.
subprocess.run([objcopy,'-I','binary','-O','ihex',str(out/'CH32_AHRS_full.bin'),str(out/'CH32_AHRS.hex')],check=True)
print(f'stub {len(stub)} B / {APP_BASE} B; app {len(app)} B at 0x{APP_BASE:04X}; app free {NV_BASE-APP_BASE-len(app)} B; '
      f'full image {len(full)} B; OTA bin {out/"CH32_AHRS_app.bin"}')
print(elf)
