; SPDX-License-Identifier: GPL-2.0-only
; Copyright (C) 2026 ZeR0-3
; This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE).
; ipl.asm - minimal built-in "pseudo IPL/BIOS" for the SHARP MZ-2800 web emulator.
;
; Used when no IPL.ROM is supplied.  It is an original, minimal re-implementation (no code from the
; real IPL.ROM) of what the FD boot path and FreeDOS-MZ2800 need:
;   * hardware init (8255 / 8254 / 8259 / Z80PIO / CRTC / palette)
;   * 80x25 text console with an 8x8 ASCII font (public-domain font8x8), no kanji / kana
;   * int 51h services: 02/03 (stub) 04/05 (FD read/write)  20/21 (key)  45 (cursor)  4F (scroll)
;     57 (putchar)  C1/C4/C5 (SASI: reported "absent")
;   * FD boot: track 0 both sides (2HD, 16 KB) -> 7000:0000, then call 7000:0000 like the real IPL
; Layout: 64 KB ROM image, code in the always-visible upper half (F000:8000..), reset vector at FFF0.
; Build: nasm -f bin ipl.asm -o ipl.bin ; build.py prepends 0x8000 bytes -> IPL.ROM
bits 16
cpu 286
org 0x8000

BD      equ 0x0040              ; BIOS data segment (same as the real BIOS)
TV      equ 0xF400              ; text VRAM (4 bytes per cell: char, 0, attr, 0)
PCGSEG  equ 0xF000              ; PCG0 (writes go to PCG even while the ROM is visible)

; ---- BIOS data (offsets in segment 0040) --------------------------------------------------------
d_ext     equ 0x0202            ; 8 bytes: extended RAM present flags (nibble per MB)
d_bootax  equ 0x0212
d_bootbx  equ 0x0214
d_bootcx  equ 0x0216
d_cur     equ 0x0A3F            ; cursor: DL=col DH=row (the shim reads/writes it)
d_attr    equ 0x0A48            ; text attribute word
d_curpos  equ 0x0A50            ; where the cursor is currently drawn
d_curon   equ 0x0A52
d_kvalid  equ 0x0A54
d_kbuf    equ 0x0A56            ; AX, BX of the buffered key
d_kprev   equ 0x0A5C            ; 14 bytes: previous key matrix (1 = released)
d_caps    equ 0x0A6C
d_fcur    equ 0x0A70            ; 4 bytes: current track per drive (FF = unknown)
d_lastdrv equ 0x0A74
d_f_wr    equ 0x0A76
d_f_drv   equ 0x0A77
d_f_side  equ 0x0A78
d_f_cyl   equ 0x0A79
d_f_sec   equ 0x0A7A
d_f_ssz   equ 0x0A7C
d_f_cnt   equ 0x0A7E
d_w       equ 0x0A80            ; window scroll scratch (8 words)
d_msg     equ 0x0A90
d_sss     equ 0x0A92
d_ssp     equ 0x0A94
d_scmd    equ 0x0A98            ; 6-byte SASI command block
d_sst     equ 0x0AA0
d_plo     equ 0x0AA2            ; boot partition start LBA (low word / high word)
d_phi     equ 0x0AA4

reset:
        cli
        cld
        mov ax, 0x6000
        mov ss, ax
        mov sp, 0x0F00
        ; ---- I/O init ------------------------------------------------------------------------
        push cs
        pop ds
        mov si, hwinit
.hw:    lodsw
        or ax, ax
        jz .hwdone
        mov dx, ax
        lodsb
        out dx, al
        jmp .hw
.hwdone:
        mov al, 0
        out 0x8D, al            ; hide the lower ROM half: PCG / text VRAM become readable
        ; ---- BIOS data area ------------------------------------------------------------------
        mov ax, BD
        mov es, ax
        xor di, di
        xor ax, ax
        mov cx, 0x800
        rep stosw
        mov ax, BD
        mov ds, ax
        mov word [d_attr], 0x0007
        mov word [d_cur], 0
        mov word [d_bootcx], 0xC000
        mov word [d_fcur], 0xFFFF
        mov word [d_fcur+2], 0xFFFF
        mov byte [d_lastdrv], 0xFF
        mov cx, 14
        mov di, d_kprev
        mov al, 0xFF
        rep stosb               ; ES=BD
        ; ---- interrupt vectors: everything -> iret, INT 51h -> BIOS ----------------------------
        xor ax, ax
        mov es, ax
        xor di, di
        mov cx, 256
.iv:    mov ax, iretstub
        stosw
        mov ax, 0xF000
        stosw
        loop .iv
        mov word [es:0x51*4], int51
        ; ---- font -> PCG0:  glyph c row i at ((c*8)+i)*2 ----------------------------------------
        mov ax, PCGSEG
        mov es, ax
        mov si, font
        xor di, di
        mov cx, 2048
.ft:    mov al, [cs:si]
        inc si
        stosb
        inc di
        loop .ft
        ; ---- clear text VRAM --------------------------------------------------------------------
        call cls
        ; ---- extended RAM probe (window register 8Ch) -> 0040:0202 ------------------------------
        call memprobe
        ; ---- banner / boot -----------------------------------------------------------------------
        sti
        mov si, s_banner
        call puts
        jmp bootloop

; ------------------------------------------------------------------------------------------------
iretstub:
        iret

; hwinit: (port word, value byte) ... 0
%macro O 2
        dw %1
        db %2
%endmacro
hwinit:
        O 0xE3, 0x82
        O 0xE2, 0x58
        O 0xE0, 0xFF
        ; 8254
        O 0xE7, 0x34
        O 0xE4, 0x20
        O 0xE4, 0x00
        O 0xE7, 0x74
        O 0xE5, 0x01
        O 0xE5, 0x00
        O 0xE7, 0xB4
        O 0xE6, 0x01
        O 0xE6, 0x00
        ; 8259 x2 (all masked)
        O 0x80, 0x11
        O 0x81, 0x40
        O 0x81, 0x80
        O 0x81, 0x11
        O 0x81, 0xFF
        O 0x82, 0x11
        O 0x83, 0x48
        O 0x83, 0x07
        O 0x83, 0x01
        O 0x83, 0xFF
        ; Z80PIO: port A = keyboard column (out), port B = rows (in)
        O 0xE9, 0xCF
        O 0xE9, 0x00
        O 0xE9, 0x07
        O 0xE8, 0x20
        O 0xEB, 0xCF
        O 0xEB, 0xFF
        O 0xEB, 0x07
        O 0xEF, 0x0F
        O 0x8F, 0x00
        O 0x174, 0x07
        O 0x274, 0x00
        O 0x176, 0x01           ; 8x8 glyphs, each row doubled
        ; CRTC text registers (same values as the real IPL)
        O 0x170, 0x00
        O 0x172, 0x05
        O 0x170, 0x03
        O 0x172, 0x11
        O 0x170, 0x05
        O 0x172, 0xD9
        O 0x170, 0x07
        O 0x172, 0x09
        O 0x170, 0x08
        O 0x172, 0x59
        O 0x170, 0x01
        O 0x172, 0x00
        O 0x170, 0x02
        O 0x172, 0x00
        O 0x170, 0x0B
        O 0x172, 0x00
        O 0x170, 0x0C
        O 0x172, 0x00
        ; 16-colour text palette registers: n -> n
%assign n 0
%rep 16
        O 0x170, 0x80 + n
        O 0x172, n
%assign n n + 1
%endrep
        ; 4096-colour palette (8 colours + 8 bright)
        O 0x00AE, 0x00
        O 0x01AE, 0x00
        O 0x02AE, 0x07
        O 0x03AE, 0x00
        O 0x04AE, 0x70
        O 0x05AE, 0x00
        O 0x06AE, 0x77
        O 0x07AE, 0x00
        O 0x08AE, 0x00
        O 0x09AE, 0x07
        O 0x0AAE, 0x07
        O 0x0BAE, 0x07
        O 0x0CAE, 0x70
        O 0x0DAE, 0x07
        O 0x0EAE, 0x77
        O 0x0FAE, 0x07
        O 0x10AE, 0x33
        O 0x11AE, 0x03
        O 0x12AE, 0x0F
        O 0x13AE, 0x00
        O 0x14AE, 0xF0
        O 0x15AE, 0x00
        O 0x16AE, 0xFF
        O 0x17AE, 0x00
        O 0x18AE, 0x00
        O 0x19AE, 0x0F
        O 0x1AAE, 0x0F
        O 0x1BAE, 0x0F
        O 0x1CAE, 0xF0
        O 0x1DAE, 0x0F
        O 0x1EAE, 0xFF
        O 0x1FAE, 0x0F
        dw 0

; ================================ memory probe ==================================================
; physical MB number M (1..14) present -> bit in byte M/2 of 0040:0202 (low nibble: even M)
memprobe:
        push ds
        push es
        mov ax, BD
        mov ds, ax
        mov ax, 0x8000
        mov es, ax
        mov bl, 1
.m:     mov al, bl
        shl al, 2
        out 0x8C, al
        mov dx, [es:0]
        mov word [es:0], 0x5555
        cmp word [es:0], 0x5555
        jne .no
        mov word [es:0], 0xAAAA
        cmp word [es:0], 0xAAAA
        jne .no
        mov [es:0], dx
        mov al, bl
        shr al, 1
        xor ah, ah
        mov di, d_ext
        add di, ax
        mov al, 0x0F
        test bl, 1
        jz .e
        mov al, 0xF0
.e:     or [di], al
.no:    inc bl
        cmp bl, 15
        jb .m
        mov al, 2
        out 0x8C, al
        pop es
        pop ds
        ret

; ================================ text console ==================================================
; cellofs: DH=row DL=col -> DI = byte offset in text VRAM.  Clobbers AX, BX.
cellofs:
        mov al, dh
        mov ah, 80
        mul ah
        xor bh, bh
        mov bl, dl
        add ax, bx
        shl ax, 2
        mov di, ax
        ret

cls:                            ; clear the text screen (DS irrelevant)
        push es
        mov ax, TV
        mov es, ax
        xor di, di
        mov cx, 2048
.c:     mov ax, 0x0020
        stosw
        mov ax, 0x0007
        stosw
        loop .c
        pop es
        ret

curhide:                        ; DS=BD
        push es
        push dx
        push di
        push ax
        push bx
        cmp byte [d_curon], 0
        je .r
        mov dx, [d_curpos]
        call cellofs
        mov ax, TV
        mov es, ax
        and byte [es:di+2], 0xBF
        mov byte [d_curon], 0
.r:     pop bx
        pop ax
        pop di
        pop dx
        pop es
        ret

curshow:                        ; DS=BD : draw the cursor (reverse attribute) at [d_cur]
        push es
        push dx
        push di
        push ax
        push bx
        mov dx, [d_cur]
        cmp dl, 79
        jbe .a
        mov dl, 79
.a:     cmp dh, 24
        jbe .b
        mov dh, 24
.b:     mov [d_curpos], dx
        call cellofs
        mov ax, TV
        mov es, ax
        or byte [es:di+2], 0x40
        mov byte [d_curon], 1
        pop bx
        pop ax
        pop di
        pop dx
        pop es
        ret

scroll1:                        ; scroll the whole screen up one line
        push ds
        push es
        mov ax, TV
        mov ds, ax
        mov es, ax
        xor di, di
        mov si, 320
        mov cx, 24 * 160
        rep movsw
        mov cx, 80
.c:     mov ax, 0x0020
        stosw
        mov ax, 0x0007
        stosw
        loop .c
        pop es
        pop ds
        ret

; putc: CL = character (CH = 0), DS=BD.  Handles CR LF BS TAB; other control codes ignored.
putc:
        push ax
        push bx
        push dx
        push di
        push es
        call curhide
        mov dx, [d_cur]
        mov al, cl
        cmp al, 0x0D
        je .cr
        cmp al, 0x0A
        je .lf
        cmp al, 0x08
        je .bs
        cmp al, 0x09
        je .tab
        cmp al, 0x20
        jb .done
        cmp dl, 80
        jb .ok
        xor dl, dl
        inc dh
        cmp dh, 25
        jb .ok
        push dx
        call scroll1
        pop dx
        mov dh, 24
.ok:    call cellofs
        mov ax, TV
        mov es, ax
        mov [es:di], cl
        mov byte [es:di+1], 0
        mov al, [d_attr]
        mov [es:di+2], al
        inc dl
        jmp .st
.cr:    xor dl, dl
        jmp .st
.bs:    or dl, dl
        jz .st
        dec dl
        jmp .st
.tab:   add dl, 8
        and dl, 0xF8
        cmp dl, 80
        jb .st
        xor dl, dl
.lf:    cmp dl, 80
        jb .lf1
        mov dl, 79
.lf1:   inc dh
        cmp dh, 25
        jb .st
        push dx
        call scroll1
        pop dx
        mov dh, 24
.st:    mov [d_cur], dx
.done:  call curshow
        pop es
        pop di
        pop dx
        pop bx
        pop ax
        ret

puts:                           ; SI = zero-terminated string in ROM (CS), DS=BD
        push cx
        push si
.l:     mov cl, [cs:si]
        inc si
        or cl, cl
        jz .d
        xor ch, ch
        call putc
        jmp .l
.d:     pop si
        pop cx
        ret

; ================================ int 51h =======================================================
; frame (BP): +00 ES +02 DS +04 DI +06 SI +08 BP +0A SP +0C BX +0E DX +10 CX +12 AX +14 IP +16 CS +18 FLAGS
int51:
        pusha
        push ds
        push es
        mov bp, sp
        mov ax, BD
        mov ds, ax
        mov es, ax
        cld
        mov al, [bp+0x13]       ; caller's AH
        mov si, disp
.d:     cmp [cs:si], al
        je .f
        add si, 3
        cmp byte [cs:si], 0
        jne .d
        jmp .x
.f:     call [cs:si+1]
.x:     pop es
        pop ds
        popa
        iret

disp:
        db 0x57
        dw h_putc
        db 0x45
        dw h_setcur
        db 0x4F
        dw h_scroll
        db 0x20
        dw h_getkey
        db 0x21
        dw h_peekkey
        db 0x04
        dw h_fd
        db 0x05
        dw h_fd
        db 0xC1
        dw h_hd
        db 0xC4
        dw h_hd
        db 0xC5
        dw h_hd
        db 0

h_putc:                         ; CX = char (CH:CL for 2-byte codes: shown as two boxes)
        mov cx, [bp+0x10]
        or ch, ch
        jz .one
        push cx
        mov cl, 0x81
        xor ch, ch
        call putc
        call putc
        pop cx
        ret
.one:   call putc
        ret

h_setcur:                       ; DX = row:col
        mov dx, [bp+0x0E]
        call curhide
        cmp dl, 79
        jbe .a
        mov dl, 79
.a:     cmp dh, 24
        jbe .b
        mov dh, 24
.b:     mov [d_cur], dx
        call curshow
        ret

; ================================ SASI ==========================================================
; int 51h AH=C1 (test unit ready) / C4 (read) / C5 (write): DL = target*2+LUN, BX = LBA[15:0],
; DH = LBA[20:16], CL = sector count (1024-byte sectors), SI:DI = physical buffer.
; The transfer is done by polling A4h/A5h (no DMA); AL = status (0 = ok), CF=1 on error.
h_hd:
        mov al, [bp+0x13]
        mov bl, 0x08
        cmp al, 0xC4
        je .go
        mov bl, 0x0A
        cmp al, 0xC5
        je .go
        mov bl, 0x00
.go:    mov [d_scmd], bl
        mov dl, [bp+0x0E]
        mov al, dl
        and al, 1
        mov cl, 5
        shl al, cl
        mov ah, [bp+0x0F]
        and ah, 0x1F
        or al, ah
        mov [d_scmd+1], al
        mov ax, [bp+0x0C]
        mov [d_scmd+3], al
        mov [d_scmd+2], ah
        mov al, [bp+0x10]
        mov [d_scmd+4], al
        mov byte [d_scmd+5], 0
        cmp byte [d_scmd], 0
        jne .k
        mov word [d_scmd+2], 0
        mov byte [d_scmd+4], 0
        mov byte [d_scmd+1], al ; (LUN only; AL is overwritten below)
        mov al, [bp+0x0E]
        and al, 1
        mov cl, 5
        shl al, cl
        mov [d_scmd+1], al
.k:     mov ax, [bp+0x06]       ; buffer SI:DI -> ES:DI
        mov cl, 12
        shl ax, cl
        mov bx, [bp+0x04]
        mov cl, 4
        shr bx, cl
        or ax, bx
        mov es, ax
        mov di, [bp+0x04]
        and di, 15
        mov dl, [bp+0x0E]
        shr dl, 1               ; target id
        call sasi_exec
        mov [bp+0x12], al
        or al, al
        jz .ok
        or word [bp+0x18], 1
        ret
.ok:    and word [bp+0x18], 0xFFFE
        ret

; sasi_exec: DL = target id, command block at d_scmd (6 bytes), ES:DI = data buffer.
; Selection, command / data / status / message phases are driven by polling.  AL = status.
sasi_exec:
        mov cl, dl
        mov al, 1
        shl al, cl
        out 0xA4, al
        mov al, 0x20            ; SEL
        out 0xA5, al
        mov dx, 4
.sb:    xor cx, cx
.sl:    in al, 0xA5
        test al, 0x20           ; BSY
        jnz .sel
        loop .sl
        dec dx
        jnz .sb
        xor al, al
        out 0xA5, al
        mov al, 0x80            ; no such unit
        ret
.sel:   xor al, al
        out 0xA5, al            ; release SEL
        xor bx, bx              ; command byte index
        mov byte [d_sst], 0
.ph:    mov dx, 16
.wo:    xor cx, cx
.wi:    in al, 0xA5
        test al, 0x80           ; REQ
        jnz .req
        test al, 0x20           ; BSY dropped: finished
        jz .fin
        loop .wi
        dec dx
        jnz .wo
        mov al, 0x80            ; timeout
        ret
.req:   and al, 0x1C            ; MSG | C/D | I/O
        cmp al, 0x08
        je .cmd
        cmp al, 0x00
        je .dout
        cmp al, 0x04
        je .din
        cmp al, 0x0C
        je .st
        cmp al, 0x1C
        je .msg
        mov al, 0x80
        ret
.cmd:   mov al, [d_scmd+bx]
        inc bx
        out 0xA4, al
        jmp .ph
.dout:  mov al, [es:di]
        inc di
        out 0xA4, al
        jmp .ph
.din:   in al, 0xA4
        mov [es:di], al
        inc di
        jmp .ph
.st:    in al, 0xA4
        mov [d_sst], al
        jmp .ph
.msg:   in al, 0xA4
        jmp .ph
.fin:   mov al, [d_sst]
        ret

; hdrd: read CL sectors from SASI unit 0: AX = LBA[15:0], DL = LBA[23:16], ES:DI = buffer.  CF on error.
hdrd:
        mov byte [d_scmd], 0x08
        and dl, 0x1F
        mov [d_scmd+1], dl
        mov [d_scmd+3], al
        mov [d_scmd+2], ah
        mov [d_scmd+4], cl
        mov byte [d_scmd+5], 0
        xor dl, dl
        call sasi_exec
        or al, al
        jz .ok
        stc
        ret
.ok:    clc
        ret

; AH=4F: scroll/clear window.  SI=lines (0/too big = clear) DX=top-left DI=bottom-right BL=attr CL=fill
; scratch d_w: +0 n  +2 left  +3 top  +4 right  +5 bottom  +6 attr  +7 fill  +8 row
h_scroll:
        call curhide
        mov ax, [bp+0x06]
        mov [d_w+0], ax
        mov ax, [bp+0x0E]
        cmp al, 79
        jbe .c1
        mov al, 79
.c1:    cmp ah, 24
        jbe .c2
        mov ah, 24
.c2:    mov [d_w+2], ax
        mov ax, [bp+0x04]
        cmp al, 79
        jbe .c3
        mov al, 79
.c3:    cmp ah, 24
        jbe .c4
        mov ah, 24
.c4:    mov [d_w+4], ax
        mov al, [bp+0x0C]
        mov [d_w+6], al
        mov al, [bp+0x10]
        mov [d_w+7], al
        mov al, [d_w+3]
        cmp al, [d_w+5]
        ja .out
        mov al, [d_w+2]
        cmp al, [d_w+4]
        ja .out
        mov cl, [d_w+5]
        sub cl, [d_w+3]
        inc cl                  ; height
        xor ch, ch
        mov ax, [d_w+0]
        or ax, ax
        jz .all
        cmp ax, cx
        jb .part
.all:   mov ax, cx
.part:  mov [d_w+0], ax
        mov al, [d_w+3]
        mov [d_w+8], al
.row:   mov al, [d_w+8]
        add al, [d_w+0]         ; source row
        cmp al, [d_w+5]
        ja .fill
        cmp word [d_w+0], 0
        je .fill
        mov dh, al
        mov dl, [d_w+2]
        call cellofs
        mov si, di              ; source offset
        mov dh, [d_w+8]
        call cellofs            ; DI = dest offset
        mov cl, [d_w+4]
        sub cl, [d_w+2]
        inc cl
        xor ch, ch
        shl cx, 1               ; words
        push ds
        mov ax, TV
        mov ds, ax
        mov es, ax
        rep movsw
        pop ds
        mov ax, BD
        mov es, ax
        jmp .next
.fill:  mov dh, [d_w+8]
        mov dl, [d_w+2]
        call cellofs
        mov cl, [d_w+4]
        sub cl, [d_w+2]
        inc cl
        xor ch, ch
        mov ax, TV
        mov es, ax
.f1:    mov al, [d_w+7]
        xor ah, ah
        stosw
        mov al, [d_w+6]
        xor ah, ah
        stosw
        loop .f1
        mov ax, BD
        mov es, ax
.next:  inc byte [d_w+8]
        mov al, [d_w+8]
        cmp al, [d_w+5]
        jbe .row
.out:   call curshow
        ret

; ================================ keyboard ======================================================
; Matrix scan: out E8h = 10h|column, in EAh = row bits (0 = pressed).  New presses are detected by
; comparing with the previous scan.  Result in d_kbuf: AX = (id<<8)|ascii, BX = info (bit1 SHIFT,
; bit4 CTRL, bit5 CAPS).  Special keys: AL=0, AH = id (F1-F10 = 01-0A, UP 60 DOWN 61 LEFT 62
; RIGHT 63 DEL 64 HOME 65) - the same values the real BIOS returns.

; kpoll: CF=1 and d_kvalid set if a key is buffered
kpoll:
        cmp byte [d_kvalid], 0
        jne .yes
        call kscan
        jnc .no
        mov [d_kbuf], ax
        mov [d_kbuf+2], bx
        mov byte [d_kvalid], 1
.yes:   stc
        ret
.no:    clc
        ret

kscan:
        push cx
        push dx
        push si
        push di
        ; read all columns into scratch d_w (14 bytes)
        xor cx, cx              ; CL = column
        mov di, d_w
.rd:    mov al, cl
        or al, 0x30
        out 0xE8, al
        in al, 0xEA
        mov [di], al
        inc di
        inc cl
        cmp cl, 14
        jb .rd
        mov al, 0x20
        out 0xE8, al            ; back to 'no column' (keeps bit5 = 80 columns)
        ; modifiers: column 11 -> row1 CAPS (toggle on press), row2 SHIFT, row4 CTRL
        mov bl, 0
        mov al, [d_w+11]
        test al, 4
        jnz .ns
        or bl, 2
.ns:    test al, 0x10
        jnz .nc
        or bl, 0x10
.nc:    mov ah, [d_kprev+11]
        test ah, 2              ; was CAPS released?
        jz .nocap
        test al, 2              ; now pressed -> toggle
        jnz .nocap
        xor byte [d_caps], 0x20
.nocap: or bl, [d_caps]
        ; released bits -> prev |= cur
        xor cx, cx
.rl:    mov si, d_w
        add si, cx
        mov di, d_kprev
        add di, cx
        mov al, [si]
        or [di], al
        inc cl
        cmp cl, 14
        jb .rl
        ; find a newly pressed key: prev & ~cur
        xor cx, cx
.fc:    mov si, d_w
        add si, cx
        mov al, [si]
        not al
        mov di, d_kprev
        add di, cx
        and al, [di]            ; AL = newly pressed bits
        jz .nx
        ; lowest set bit -> DL
        xor dx, dx
.bt:    test al, 1
        jnz .got
        shr al, 1
        inc dl
        jmp .bt
.got:   mov al, 1
        push cx
        mov cl, dl
        shl al, cl
        pop cx
        not al
        and [di], al            ; mark pressed in prev
        ; table index = col*8 + bit
        mov si, cx
        shl si, 3
        xor dh, dh
        add si, dx
        mov al, [cs:ktab_n+si]
        test bl, 2
        jz .ns2
        mov al, [cs:ktab_s+si]
.ns2:   or al, al
        jz .nx                  ; no function: consume, keep scanning
        cmp al, 0x80
        jae .special
        ; letters: CAPS inverts the case, CTRL -> control code
        mov ah, al
        and ah, 0xDF
        cmp ah, 'A'
        jb .ret
        cmp ah, 'Z'
        ja .ret
        test bl, 0x20
        jz .nocs
        xor al, 0x20
.nocs:  test bl, 0x10
        jz .ret
        and al, 0x1F
.ret:   xor ah, ah
        xor bh, bh
        stc
        jmp .end
.special:
        sub al, 0x80
        mov ah, al
        xor al, al
        xor bh, bh
        stc
        jmp .end
.nx:    inc cl
        cmp cl, 14
        jb .fc
        clc
.end:   pop di
        pop si
        pop dx
        pop cx
        ret

h_getkey:
        call kpoll
        jnc .none
        mov ax, [d_kbuf]
        mov [bp+0x12], ax
        mov ax, [d_kbuf+2]
        mov [bp+0x0C], ax
        mov byte [d_kvalid], 0
        and word [bp+0x18], 0xFFBF
        ret
.none:  mov word [bp+0x12], 0
        or word [bp+0x18], 0x40
        ret

h_peekkey:
        call kpoll
        jnc h_getkey.none
        mov ax, [d_kbuf]
        mov [bp+0x12], ax
        mov ax, [d_kbuf+2]
        mov [bp+0x0C], ax
        and word [bp+0x18], 0xFFBF
        ret

; key tables: index = column*8 + row bit.  00 = no function, 80+id = special key.
; (JIS keyboard layout)
ktab_n:
        db 0x81,0x82,0x83,0x84,0x85,0x86,0x87,0x88         ; 0: F1-F8
        db 0x89,0x8A,'8','9',',','.','+','-'               ; 1: F9 F10 np8 np9 np, np. np+ np-
        db '0','1','2','3','4','5','6','7'                 ; 2: np0-np7
        db 0x09,' ',0x0D,0xE0,0xE1,0xE2,0xE3,0             ; 3: TAB SPACE ENTER UP DOWN LEFT RIGHT PAUSE
        db '/','a','b','c','d','e','f','g'                 ; 4
        db 'h','i','j','k','l','m','n','o'                 ; 5
        db 'p','q','r','s','t','u','v','w'                 ; 6
        db 'x','y','z','^',0x5C,0x5C,'.',','               ; 7
        db '0','1','2','3','4','5','6','7'                 ; 8
        db '8','9',':',';','-','@','[',0                   ; 9
        db ']',0,0xE5,0xE4,0x08,0x1B,'*','/'               ; 10
        times 24 db 0                                      ; 11-13
ktab_s:
        db 0x81,0x82,0x83,0x84,0x85,0x86,0x87,0x88
        db 0x89,0x8A,'8','9',',','.','+','-'
        db '0','1','2','3','4','5','6','7'
        db 0x09,' ',0x0D,0xE0,0xE1,0xE2,0xE3,0
        db '?','A','B','C','D','E','F','G'
        db 'H','I','J','K','L','M','N','O'
        db 'P','Q','R','S','T','U','V','W'
        db 'X','Y','Z','~','|','_','>','<'
        db 0,'!',0x22,'#','$','%','&',0x27
        db '(',')','*','+','=','`','{',0
        db '}',0,0xE5,0xE4,0x08,0x1B,'*','/'
        times 24 db 0

; ================================ floppy ========================================================
; h_fd: int 51h AH=04 (read) / 05 (write): AL=side BL=cylinder BH=sector DL=drive DH=size code
;       (bytes = 256 << DH) CX=byte count SI:DI = physical buffer.  CF=1 / AL=status on error.
h_fd:
        mov ax, [bp+0x12]
        mov bx, [bp+0x0C]
        mov cx, [bp+0x10]
        mov dx, [bp+0x0E]
        mov si, [bp+0x06]
        mov di, [bp+0x04]
        call fdrw
        jc .e
        and word [bp+0x18], 0xFFFE      ; success: AL (the caller's side number) is preserved
        ret
.e:     mov [bp+0x12], al               ; error: AL = FDC status
        or word [bp+0x18], 1
        ret

; fdrw: same register convention (AH=4/5).  DS=BD.  Returns CF, AL=status (0 = ok).
fdrw:
        cld
        sub ah, 4
        mov [d_f_wr], ah
        and dl, 3
        mov [d_f_drv], dl
        mov [d_f_side], al
        mov [d_f_cyl], bl
        mov [d_f_sec], bh
        mov [d_f_cnt], cx
        mov cl, dh
        mov ax, 0x100
        shl ax, cl
        mov [d_f_ssz], ax
        mov al, 1               ; 2HD (bit0) for 1024-byte sectors, 2DD for 512
        cmp dh, 2
        jae .m
        xor al, al
.m:     out 0xDF, al
        ; buffer SI:DI -> ES:DI
        mov ax, si
        mov cl, 12
        shl ax, cl
        mov bx, di
        mov cl, 4
        shr bx, cl
        or ax, bx
        mov es, ax
        and di, 15
        ; drive / side
        mov al, [d_f_drv]
        or al, 0x80
        out 0xDC, al
        mov al, [d_f_side]
        out 0xDD, al
        call fdseek
        jc .err
.sec:   mov al, [d_f_sec]
        out 0xDA, al
        cmp byte [d_f_wr], 0
        jne .w
        mov al, 0x80
        out 0xD8, al
        mov cx, [d_f_ssz]
.rb:    mov si, 0
.rp:    in al, 0xD8
        test al, 2
        jnz .rg
        test al, 1
        jz .rend
        dec si
        jnz .rp
        jmp .tmo
.rg:    in al, 0xDB
        stosb
        loop .rb
        jmp .fin
.w:     mov al, 0xA0
        out 0xD8, al
        mov cx, [d_f_ssz]
.wb:    mov si, 0
.wp:    in al, 0xD8
        test al, 2
        jnz .wg
        test al, 1
        jz .rend
        dec si
        jnz .wp
        jmp .tmo
.wg:    mov al, [es:di]
        inc di
        out 0xDB, al
        loop .wb
.fin:   call fdwait
        jc .tmo
        in al, 0xD8
        test al, 0x9C           ; not ready / RNF(10) / CRC(08) / lost data(04) ; bit7 = not ready
        jnz .err
        inc byte [d_f_sec]
        mov ax, [d_f_cnt]
        sub ax, [d_f_ssz]
        jbe .ok
        mov [d_f_cnt], ax
        jmp .sec
.ok:    xor al, al
        clc
        ret
.rend:  call fdwait
        in al, 0xD8
        or al, al
        jnz .err
        mov al, 0x10
.err:   or al, al
        jnz .e2
        mov al, 0x10
.e2:    stc
        ret
.tmo:   mov al, 0x80
        stc
        ret

; fdwait: wait until the FDC is not busy.  CF=1 on timeout.
fdwait:
        push cx
        push dx
        mov dx, 32
.o:     xor cx, cx
.i:     in al, 0xD8
        test al, 1
        jz .ok
        loop .i
        dec dx
        jnz .o
        pop dx
        pop cx
        stc
        ret
.ok:    pop dx
        pop cx
        clc
        ret

; fdseek: restore when the drive changed / is unknown, then seek to [d_f_cyl]
fdseek:
        mov bl, [d_f_drv]
        xor bh, bh
        mov al, [d_lastdrv]
        cmp al, bl
        jne .res
        cmp byte [d_fcur+bx], 0xFF
        jne .known
.res:   mov [d_lastdrv], bl
        mov al, 0x00            ; restore
        out 0xD8, al
        call fdwait
        jc .bad
        mov byte [d_fcur+bx], 0
.known: mov al, [d_fcur+bx]
        mov ah, [d_f_cyl]
        cmp al, ah
        je .done
        out 0xD9, al            ; track register = current track
        mov al, ah
        out 0xDB, al            ; data register = target
        mov al, 0x10            ; seek
        out 0xD8, al
        call fdwait
        jc .bad
        mov al, [d_f_cyl]
        mov [d_fcur+bx], al
.done:  clc
        ret
.bad:   mov byte [d_fcur+bx], 0xFF
        mov byte [d_lastdrv], 0xFF
        stc
        ret

; ================================ boot ==========================================================
bootloop:
        mov ax, BD
        mov ds, ax
        mov byte [d_msg], 0
.again: xor dx, dx              ; FD0
        call tryfd
        mov dx, 1               ; FD1
        call tryfd
        call tryhd              ; SASI unit 0
        cmp byte [d_msg], 0
        jne .wait
        mov byte [d_msg], 1
        mov si, s_nodisk
        call puts
.wait:  mov cx, 0x20            ; ~ a short pause between polls
.w1:    push cx
        xor cx, cx
.w2:    in al, 0xD8
        loop .w2
        pop cx
        loop .w1
        jmp .again

; tryfd: DL = drive.  Loads track 0 (both sides) to 7000:0000; boots it if it starts with E9/EB.
tryfd:
        push dx
        mov ax, 0x0400          ; read, side 0
        xor bx, bx
        mov bh, 1               ; cylinder 0, sector 1
        mov dh, 2
        mov cx, 0x2000
        mov si, 7
        xor di, di
        call fdrw
        jc .fail
        pop dx
        push dx
        mov ax, 0x0401          ; side 1
        xor bx, bx
        mov bh, 1
        mov dh, 2
        mov cx, 0x2000
        mov si, 7
        mov di, 0x2000
        call fdrw
        jc .fail
        mov ax, 0x7000
        mov es, ax
        mov al, [es:0]
        and al, 0xFD
        cmp al, 0xE9
        jne .fail
        pop dx
        mov word [d_plo], 0
        mov word [d_phi], 0
        call startboot          ; DX = boot device
        push dx
.fail:  pop dx
        ret

; tryhd: SASI unit 0, same procedure as the real IPL: LBA0 (word 0400h, partition table LBA at +0Ch)
; -> table of 8 x 32 bytes (type high nibble 2, flags & C3 = C3, start LBA at +2..+4) -> the first
; partition whose first sector starts with E9/EB -> 16 sectors to 7000:0000.
tryhd:
        mov ax, 0x7800          ; 7000:8000
        mov es, ax
        xor di, di
        xor ax, ax
        xor dx, dx
        mov cl, 1
        call hdrd
        jc .no
        cmp word [es:0], 0x0400
        jne .no
        mov ax, [es:0x0C]
        mov dl, [es:0x0E]
        mov bx, 0x7840          ; 7000:8400
        mov es, bx
        xor di, di
        mov cl, 1
        call hdrd
        jc .no
        xor si, si
        mov cx, 8
.e:     push cx
        push si
        mov ax, 0x7840
        mov es, ax
        mov al, [es:si]
        and al, 0xF0
        cmp al, 0x20
        jne .nx
        mov al, [es:si+1]
        and al, 0xC3
        cmp al, 0xC3
        jne .nx
        mov ax, [es:si+2]
        mov dl, [es:si+4]
        mov [d_plo], ax
        xor dh, dh
        mov [d_phi], dx
        mov bx, 0x7880          ; 7000:8800: first sector of the partition
        mov es, bx
        xor di, di
        mov cl, 1
        call hdrd
        jc .nx
        mov al, [es:0]
        and al, 0xFD
        cmp al, 0xE9
        jne .nx
        mov ax, 0x7000          ; the boot area: 16 sectors
        mov es, ax
        xor di, di
        mov ax, [d_plo]
        mov dl, [d_phi]
        mov cl, 16
        call hdrd
        jc .nx
        mov al, [es:0]
        and al, 0xFD
        cmp al, 0xE9
        jne .nx
        pop si
        pop cx
        mov dx, 4               ; boot device: SASI unit 0
        call startboot
        ret
.nx:    pop si
        pop cx
        add si, 32
        loop .e
.no:    ret

; startboot: boot area is in 7000:0000.  DX = boot device, d_plo/d_phi = partition start (HDD).
startboot:
        mov [d_bootbx], dx
        mov si, s_boot
        call puts
        mov ax, 0x6FF0
        mov es, ax
        xor ax, ax
        mov [es:0], ax
        mov [es:2], dx
        mov word [es:4], 0xC000
        mov word [es:6], 0xF000
        mov ax, [d_plo]
        mov [es:8], ax
        mov ax, [d_phi]
        mov [es:10], ax
        mov word [es:12], 0
        mov word [es:14], 0
        mov [d_sss], ss
        mov [d_ssp], sp
        mov bx, dx
        mov ax, 0x6FF0
        cli
        mov ss, ax
        xor sp, sp
        sti
        mov ds, ax
        xor ax, ax
        mov cx, 0xC000
        mov dx, 0xF000
        call 0x7000:0x0000
        ; the boot sector returned: restore our own context and poll again
        mov ax, BD
        mov ds, ax
        cli
        mov ss, [d_sss]
        mov sp, [d_ssp]
        sti
        ret

s_banner:  db "MZ-2800 pseudo IPL (built-in, no ROM image)", 13, 10, 0
s_nodisk:  db "Insert a boot disk (FD0/FD1)...", 13, 10, 0
s_boot:    db "Booting...", 13, 10, 0

font:
        incbin "font.bin"

; ---- reset vector -------------------------------------------------------------------------------
        times 0x7FF0 - ($ - $$) db 0
        jmp 0xF000:0x8000
        times 0x8000 - ($ - $$) db 0
