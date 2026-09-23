#!/usr/bin/env python3
"""生成小程序用的 GBK 解码表。

微信 / 支付宝导出的账单 CSV 多为 GBK，而小程序运行时没有 TextDecoder('gbk')，
所以把 GBK 双字节区间的映射固化成一张表随包发布。

索引算法与 utils/gbk.js 里的 decodeGbk 保持一致：
    lead  0x81..0xFE（126 个）
    trail 0x40..0xFE，跳过 0x7F（190 个）
    index = (lead - 0x81) * 190 + (trail - 0x40 - (trail > 0x7F ? 1 : 0))
非法组合写 U+FFFD 占位，保证下标可以直接算出来。

用法：
    python3 miniprogram/tools/gen-gbk-table.py
"""

import pathlib

LEAD_START, LEAD_END = 0x81, 0xFE
TRAIL_START, TRAIL_END = 0x40, 0xFE
REPLACEMENT = "\ufffd"

TRAIL_COUNT = sum(1 for t in range(TRAIL_START, TRAIL_END + 1) if t != 0x7F)
TOTAL = (LEAD_END - LEAD_START + 1) * TRAIL_COUNT


def build() -> str:
    out = []
    for lead in range(LEAD_START, LEAD_END + 1):
        for trail in range(TRAIL_START, TRAIL_END + 1):
            if trail == 0x7F:
                continue
            try:
                ch = bytes([lead, trail]).decode("gbk")
            except UnicodeDecodeError:
                ch = REPLACEMENT
            if len(ch) != 1 or ord(ch) > 0xFFFF:
                ch = REPLACEMENT
            out.append(ch)
    assert len(out) == TOTAL, (len(out), TOTAL)
    return "".join(out)


def main() -> None:
    table = build()
    target = pathlib.Path(__file__).resolve().parents[1] / "utils" / "gbk-table.js"
    chunks = [table[i : i + 96] for i in range(0, len(table), 96)]
    body = " +\n  ".join("'" + c.replace("\\", "\\\\").replace("'", "\\'") + "'" for c in chunks)
    content = (
        "/**\n"
        " * GBK 双字节解码表（自动生成，勿手改）。\n"
        f" * 由 tools/gen-gbk-table.py 生成，共 {TOTAL} 项，非法组合为 U+FFFD 占位，\n"
        " * 下标 = (lead - 0x81) * 190 + (trail - 0x40 - (trail > 0x7F ? 1 : 0))。\n"
        " */\n"
        "module.exports = {\n"
        f"  LEAD_COUNT: {LEAD_END - LEAD_START + 1},\n"
        f"  TRAIL_COUNT: {TRAIL_COUNT},\n"
        "  TABLE:\n  " + body + ",\n"
        "}\n"
    )
    target.write_text(content, encoding="utf-8")
    print(f"wrote {target} ({len(content)} bytes, {TOTAL} entries)")


if __name__ == "__main__":
    main()
