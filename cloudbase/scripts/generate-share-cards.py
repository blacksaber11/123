#!/usr/bin/env python3
"""代码生成小程序分享卡片图（5:4 比例，微信分享卡片推荐尺寸）。

每类内容一张卡：品牌色渐变底 + 品类角标 + 标题 + 关键信息 + 底部平台标识。
卡片不包含任何联系方式与敏感信息，只用公开字段（品类 / 型号 / 数量 / 城市 / 价格）。

产物：
- cloudbase/miniprogram/assets/share/card-product.png     商品出售
- cloudbase/miniprogram/assets/share/card-rent.png        商品出租
- cloudbase/miniprogram/assets/share/card-demand.png      求购需求
- cloudbase/miniprogram/assets/share/card-demand-rent.png 租赁需求
- cloudbase/miniprogram/assets/share/card-home.png        首页
- cloudbase/miniprogram/assets/share/card-biz.png         商机
- cloudbase/miniprogram/assets/share/card-agency.png      委托

只依赖 Pillow，可重复执行覆盖。
"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'assets', 'share')
SCALE = 2  # 超采样倍数

W, H = 900, 720          # 5:4 卡片尺寸
BRAND = '#0B7A4B'
INK = '#171717'
MUTED = '#71717A'
WHITE = '#FFFFFF'

FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]


def pick_font(size):
    """挑一个可用的中文字体；找不到就用 PIL 默认位图字体。"""
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def font(size):
    return pick_font(size)


def text_width(draw, s, f):
    box = draw.textbbox((0, 0), s, font=f)
    return box[2] - box[0]


def truncate(draw, s, f, max_w):
    """超宽就截断并加省略号，保证不溢出卡片。"""
    s = str(s or '')
    if text_width(draw, s, f) <= max_w:
        return s
    out = s
    while out and text_width(draw, out + '…', f) > max_w:
        out = out[:-1]
    return out + '…'


def hex_rgb(value):
    """'#0B7A4B' → (11, 122, 75)。"""
    v = str(value).lstrip('#')
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def vertical_gradient(size, top, bottom):
    """竖向渐变底色。"""
    t0, t1 = hex_rgb(top), hex_rgb(bottom)
    w, h = size
    img = Image.new('RGB', (1, h))
    px = img.load()
    for y in range(h):
        t = y / float(max(1, h - 1))
        px[0, y] = (
            int(t0[0] + (t1[0] - t0[0]) * t),
            int(t0[1] + (t1[1] - t0[1]) * t),
            int(t0[2] + (t1[2] - t0[2]) * t)
        )
    return img.resize((w, h), Image.BILINEAR)


def rounded_panel(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_card(name, kind, title, meta, footer, accent, badge):
    """画一张分享卡片：渐变底 + 白色面板 + 角标 + 标题 + 信息行 + 底部标识。"""
    S = SCALE
    w, h = W * S, H * S
    img = vertical_gradient((w, h), '#0E201A', accent)
    d = ImageDraw.Draw(img, 'RGBA')

    # 右上角装饰圆：纯视觉，不承载信息
    d.ellipse((w - 320 * S, -180 * S, w + 200 * S, 340 * S), fill=(255, 255, 255, 16))
    d.ellipse((w - 140 * S, h - 260 * S, w + 180 * S, h + 60 * S), fill=(255, 255, 255, 10))

    # 主面板
    pad = 56 * S
    panel = (pad, 92 * S, w - pad, h - 92 * S)
    rounded_panel(d, panel, radius=36 * S, fill=(255, 255, 255, 250))

    x = panel[0] + 44 * S
    y = panel[1] + 44 * S
    right = panel[2] - 44 * S

    # 角标（品类 / 交易方式）
    f_badge = font(28 * S)
    tw = text_width(d, badge, f_badge)
    rounded_panel(d, (x, y, x + tw + 32 * S, y + 56 * S), radius=16 * S, fill=accent)
    d.text((x + 16 * S, y + 12 * S), badge, font=f_badge, fill=WHITE)
    y += 56 * S + 30 * S

    # 主标题（两行内截断）
    f_title = font(52 * S)
    title = truncate(d, title, f_title, right - x)
    d.text((x, y), title, font=f_title, fill=INK)
    y += 66 * S

    # 副标题 / 型号
    f_sub = font(30 * S)
    d.text((x, y), truncate(d, meta[0], f_sub, right - x), font=f_sub, fill=MUTED)
    y += 46 * S

    # 信息标签行
    f_tag = font(26 * S)
    tx = x
    for tag in meta[1]:
        tw = text_width(d, tag, f_tag)
        if tx + tw + 28 * S > right:
            break
        rounded_panel(d, (tx, y, tx + tw + 28 * S, y + 52 * S), radius=14 * S, fill=(238, 246, 241, 255))
        d.text((tx + 14 * S, y + 11 * S), tag, font=f_tag, fill=BRAND)
        tx += tw + 28 * S + 14 * S
    y += 52 * S + 34 * S

    # 分隔线：始终从内容区左缘拉到右缘，不受标签行宽度影响
    d.line((x, y, right, y), fill=(228, 228, 231, 255), width=2 * S)
    y += 32 * S

    # 卖点说明
    f_note = font(28 * S)
    d.text((x, y), truncate(d, meta[2], f_note, right - x), font=f_note, fill=(63, 63, 70, 255))
    y += 44 * S

    # 底部：平台标识 + 引导语
    f_foot = font(26 * S)
    d.text((x, panel[3] - 76 * S), footer[0], font=f_foot, fill=MUTED)
    f_foot2 = font(30 * S)
    d.text((right - text_width(d, footer[1], f_foot2), panel[3] - 80 * S), footer[1], font=f_foot2, fill=accent)

    out = img.resize((W, H), Image.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    out.save(os.path.join(OUT, name + '.png'))
    print('generated', name + '.png')


def main():
    os.makedirs(OUT, exist_ok=True)

    draw_card(
        'card-product', '商品',
        'H100 80G SXM 整机现货',
        ('NVIDIA H100 · GPU 服务器 · 全新', ['32 台', '深圳', '现货'], '支持同台互验与先验资再看货'),
        ('算力聚合', '先筛选 · 再联系'),
        BRAND, '出售 · 现货'
    )
    draw_card(
        'card-rent', '商品',
        'H100 80G 算力出租',
        ('NVIDIA H100 · 按月计费', ['8 卡起租', '上海', '当日可起租'], '可签租赁意向协议，支持暗语视频验机'),
        ('算力聚合', '先筛选 · 再联系'),
        '#1D4ED8', '出租 · 按月'
    )
    draw_card(
        'card-demand', '需求',
        '求购 A100 80G PCIE',
        ('NVIDIA A100 · 求购需求', ['需 20 张', '北京', '可开专票'], '接受同台互验，支持资金监管账户'),
        ('算力聚合', '先筛选 · 再联系'),
        '#E85600', '求购 · 现货'
    )
    draw_card(
        'card-demand-rent', '需求',
        '求租 H100 80G 算力',
        ('NVIDIA H100 · 租赁需求', ['需 32 卡', '杭州', '3 天内'], '接受签署租赁意向协议，承诺不转租'),
        ('算力聚合', '先筛选 · 再联系'),
        '#7C3AED', '求租 · 按月'
    )
    draw_card(
        'card-home', '首页',
        '算力设备 · 实名货源直连',
        ('GPU 服务器 / 内存 / 整机 · 买卖与租赁', ['实名主体', '条件先行', '平台担保流程'], '发布免费，先确认必须条件再与货主直接对话'),
        ('算力聚合', '查看货源'),
        BRAND, '算力交易'
    )
    draw_card(
        'card-biz', '商机',
        '实时货盘 · 囤货榜单',
        ('按品类与型号汇总的买卖盘口', ['GPU 榜', '内存榜', '今日热词'], '开通商机后按库存匹配并领取需求联系方式'),
        ('算力聚合', '开通商机'),
        '#0E9159', '商机 · 99 元/月'
    )
    draw_card(
        'card-agency', '委托',
        '代采 / 代售 · 平台代寻',
        ('按真实需求填写，平台核验后代寻货源', ['1000 万以内先付', '大额资料核验'], '代采订单仅平台可见，代售可选公开或保密'),
        ('算力聚合', '发起委托'),
        '#2563EB', '委托 · 代寻代验'
    )


if __name__ == '__main__':
    main()
