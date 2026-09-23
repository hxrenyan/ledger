#!/usr/bin/env python3
"""生成 tabBar 图标（81x81 PNG，正常态灰 / 选中态蓝）。

不引第三方库：直接按 PNG 规范写 IHDR/IDAT/IEND，像素数据用 zlib 压。
图标形状用最朴素的方式画（矩形、圆、圆角矩形），风格和界面一致——细线条、无填充。

用法：
    python3 miniprogram/tools/gen-tabbar-icons.py
产物：
    miniprogram/images/tab-{list,gift,wallet,user}[-on].png
"""

import pathlib
import struct
import zlib

SIZE = 81
STROKE = 6
NORMAL = (142, 142, 147, 255)   # #8e8e93
ACTIVE = (59, 91, 219, 255)     # #3b5bdb

OUT = pathlib.Path(__file__).resolve().parent.parent / "images"


class Canvas:
    def __init__(self, size):
        self.size = size
        self.px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    def set(self, x, y, color):
        if 0 <= x < self.size and 0 <= y < self.size:
            self.px[y][x] = color

    def rect(self, x0, y0, x1, y1, color, width=STROKE):
        """描边矩形（不含填充）。坐标含端点。"""
        for i in range(width):
            for x in range(x0, x1 + 1):
                self.set(x, y0 + i, color)
                self.set(x, y1 - i, color)
            for y in range(y0, y1 + 1):
                self.set(x0 + i, y, color)
                self.set(x1 - i, y, color)

    def round_rect(self, x0, y0, x1, y1, radius, color, width=STROKE):
        """圆角描边矩形：四角用圆的象限判断裁掉。"""
        for i in range(width):
            for y in range(y0 + i, y1 - i + 1):
                for x in range(x0 + i, x1 - i + 1):
                    # 只画边框：落在内缩矩形上
                    on_edge = (
                        x <= x0 + i or x >= x1 - i or y <= y0 + i or y >= y1 - i
                    )
                    if not on_edge:
                        continue
                    # 圆角判断
                    cx = None
                    cy = None
                    if x < x0 + radius and y < y0 + radius:
                        cx, cy = x0 + radius, y0 + radius
                    elif x > x1 - radius and y < y0 + radius:
                        cx, cy = x1 - radius, y0 + radius
                    elif x < x0 + radius and y > y1 - radius:
                        cx, cy = x0 + radius, y1 - radius
                    elif x > x1 - radius and y > y1 - radius:
                        cx, cy = x1 - radius, y1 - radius
                    if cx is not None:
                        # 外侧圆角：距离圆心超过 radius 的点丢掉
                        dx, dy = x - cx, y - cy
                        if abs(dx) > 0 and abs(dy) > 0:
                            if dx * dx + dy * dy > radius * radius:
                                continue
                    self.set(x, y, color)

    def circle(self, cx, cy, r, color, width=STROKE, filled=False):
        for y in range(cy - r - width, cy + r + width + 1):
            for x in range(cx - r - width, cx + r + width + 1):
                d2 = (x - cx) ** 2 + (y - cy) ** 2
                if filled:
                    if d2 <= r * r:
                        self.set(x, y, color)
                elif (r - width) ** 2 <= d2 <= r * r:
                    self.set(x, y, color)

    def line(self, x0, y0, x1, y1, color, width=STROKE):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1) * 2
        for s in range(steps + 1):
            t = s / steps
            x = round(x0 + (x1 - x0) * t)
            y = round(y0 + (y1 - y0) * t)
            half = width // 2
            for dy in range(-half, half + 1):
                for dx in range(-half, half + 1):
                    self.set(x + dx, y + dy, color)

    def rounded_line(self, x0, y0, x1, y1, color, width=STROKE):
        """水平/垂直粗线，两端补圆头，看起来和圆角一致。"""
        self.line(x0, y0, x1, y1, color, width)
        half = width // 2
        self.circle(x0, y0, half, color, width=half + 1, filled=True)
        self.circle(x1, y1, half, color, width=half + 1, filled=True)

    def png(self):
        raw = b""
        for row in self.px:
            raw += b"\x00" + b"".join(bytes(px) for px in row)

        def chunk(tag, data):
            body = tag + data
            return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

        ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )


def icon_list(color):
    """明细：三条横线，长度不同，像流水列表。"""
    c = Canvas(SIZE)
    for i, (y, x1) in enumerate([(24, 58), (40, 62), (56, 44)]):
        c.rounded_line(20, y, x1, y, color)
        void = i
    return c


def icon_gift(color):
    """人情：礼盒（盒身 + 盖 + 丝带）。"""
    c = Canvas(SIZE)
    c.round_rect(18, 34, 62, 62, 8, color)
    c.rounded_line(14, 32, 66, 32, color)          # 盒盖
    c.rounded_line(40, 16, 40, 62, color)          # 竖丝带
    c.line(28, 20, 40, 30, color, 5)               # 左蝴蝶结
    c.line(52, 20, 40, 30, color, 5)               # 右蝴蝶结
    return c


def icon_wallet(color):
    """资产：钱包（圆角矩形 + 右侧卡扣）。"""
    c = Canvas(SIZE)
    c.round_rect(14, 24, 66, 60, 12, color)
    c.circle(52, 42, 8, color, width=5)
    c.rounded_line(20, 34, 46, 34, color, 5)
    return c


def icon_user(color):
    """我的：头 + 肩。"""
    c = Canvas(SIZE)
    c.circle(40, 30, 13, color, width=6)
    # 肩膀用一段圆弧近似
    for x in range(16, 65):
        for y in range(44, 66):
            dx = x - 40
            dy = y - 68
            d = (dx * dx + dy * dy) ** 0.5
            if 22 <= d <= 27:
                c.set(x, y, color)
    return c


ICONS = {
    "list": icon_list,
    "gift": icon_gift,
    "wallet": icon_wallet,
    "user": icon_user,
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in ICONS.items():
        for suffix, color in (("", NORMAL), ("-on", ACTIVE)):
            path = OUT / f"tab-{name}{suffix}.png"
            path.write_bytes(fn(color).png())
            print(f"{path.relative_to(OUT.parent.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
