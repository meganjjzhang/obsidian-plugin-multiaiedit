#!/usr/bin/env python3
"""Generate Lottie JSON from logo.svg animation definition.

Creates a vector-based Lottie JSON that can be converted to PAG via
PAGConvertor for a higher-quality, resolution-independent PAG file.
"""

import json
import math
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
LOTTIE_PATH = PROJECT / "img" / "logo_lottie.json"

# Animation timing (matching logo.svg)
FPS = 30
WIDTH = 512
HEIGHT = 512

# Colors (from logo.svg)
HALO_COLOR = [0.804, 0.808, 0.878, 1.0]   # #CDCEE0
NETWORK_COLOR = [0.459, 0.435, 0.655, 1.0]  # #756FA7
NODE_COLOR = [0.392, 0.365, 0.561, 1.0]     # #645D8F
SPARK_COLOR = [0.980, 0.686, 0.443, 1.0]    # #FAAF71

# Halo geometry (centered at 256,256, radius 164)
CX, CY = 256, 256
R = 164

# Node positions on the circle (top, right, bottom, left)
NODES = [
    (256, 92),   # top
    (420, 256),  # right
    (256, 420),  # bottom
    (92, 256),   # left
]


def arc_path(start_angle, end_angle, radius=R, cx=CX, cy=CY, num_points=32):
    """Generate Lottie path data for an arc."""
    points = []
    for i in range(num_points + 1):
        angle = start_angle + (end_angle - start_angle) * i / num_points
        x = cx + radius * math.cos(angle)
        y = cy + radius * math.sin(angle)
        points.append([x, y])
    return points


def bezier_path(p0, p1, p2, p3, num_points=32):
    """Generate Lottie path data for a cubic bezier."""
    points = []
    for i in range(num_points + 1):
        t = i / num_points
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        points.append([x, y])
    return points


def points_to_lottie_path(points, closed=False):
    """Convert points list to Lottie shape path format."""
    if len(points) < 2:
        return {"c": closed, "i": [], "o": [], "v": points}

    vertices = points
    in_tangents = [[0, 0]] * len(points)
    out_tangents = [[0, 0]] * len(points)
    return {"c": closed, "i": in_tangents, "o": out_tangents, "v": vertices}


def make_keyframe(value, time_frames, time_s=None):
    """Create a simple keyframe with one value at a specific time."""
    if time_s is None:
        time_s = time_frames / FPS
    return {
        "i": {"x": [0.667], "y": [1]},
        "o": {"x": [0.333], "y": [0]},
        "s": [value],
        "t": time_frames,
    }


def make_animated_property(keyframes, prop_index=0):
    """Create an animated property with multiple keyframes."""
    return {"a": 1, "k": keyframes}


def make_static_property(value):
    """Create a static (non-animated) property."""
    return {"a": 0, "k": value}


def make_shape_group(items, transform=None, name="group"):
    """Create a shape group."""
    group = {"ty": "gr", "it": items, "nm": name, "np": len(items)}
    return group


def make_fill(color, name="fill"):
    """Create a fill shape."""
    return {
        "ty": "fl",
        "c": make_static_property(color),
        "o": make_static_property(100),
        "r": 1,
        "nm": name,
    }


def make_stroke(color, width=18, name="stroke", line_cap=2, line_join=2):
    """Create a stroke shape."""
    return {
        "ty": "st",
        "c": make_static_property(color),
        "o": make_static_property(100),
        "w": make_static_property(width),
        "lc": line_cap,  # 2 = round
        "lj": line_join,  # 2 = round
        "ml": 4,
        "nm": name,
    }


def make_path(path_data, name="path"):
    """Create a path shape."""
    return {
        "ty": "sh",
        "d": 1,
        "ks": make_static_property(path_data),
        "nm": name,
    }


def make_trim(start_frames, end_frames, name="trim"):
    """Create a trim paths shape for line-drawing effect."""
    # Start at 0%, animate to 100%
    start_kfs = [
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": start_frames},
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": end_frames},
    ]
    end_kfs = [
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": start_frames},
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [100], "t": end_frames},
    ]
    return {
        "ty": "tm",
        "s": {"a": 1, "k": start_kfs},
        "e": {"a": 1, "k": end_kfs},
        "o": make_static_property(0),
        "m": 1,
        "nm": name,
    }


def make_transform(rotation_kfs=None, opacity_kfs=None, position=None):
    """Create a transform property group."""
    if position is None:
        position = [CX, CY]

    result = {
        "ty": "tr",
        "p": make_static_property(position),
        "a": make_static_property([0, 0]),
        "s": make_static_property([100, 100]),
        "sk": make_static_property(0),
        "sa": make_static_property(0),
    }

    if rotation_kfs is not None:
        result["r"] = {"a": 1, "k": rotation_kfs}
    else:
        result["r"] = make_static_property(0)

    if opacity_kfs is not None:
        result["o"] = {"a": 1, "k": opacity_kfs}
    else:
        result["o"] = make_static_property(100)

    return result


def build_halo_layer(index):
    """Build one quarter-arc halo layer."""
    # Four arcs of 78° each with 12° gaps between them
    # (measured from top, clockwise in screen coords)
    angles = [
        (-math.pi/2, -math.pi/2 + math.radians(78)),       # top to ~-12°
        (0, math.radians(78)),                                # right to ~78°
        (math.pi/2, math.pi/2 + math.radians(78)),          # bottom to ~168°
        (math.pi, math.pi + math.radians(78)),               # left to ~258°
    ]

    start_a, end_a = angles[index]
    pts = arc_path(start_a, end_a)
    path_data = points_to_lottie_path(pts, closed=False)

    # Opacity: alternate between 100% and 85%
    opacity = 100 if index % 2 == 0 else 85

    # The halo rotates continuously. We use a rotation keyframe animation.
    # 60s for full rotation at 30fps = 1800 frames
    rotation_kfs = [
        {"i": {"x": [0.833], "y": [0.833]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": 0},
        {"s": [360], "t": 1800},
    ]

    items = [
        make_path(path_data, f"halo_arc_{index}"),
        make_stroke(HALO_COLOR, width=18, name=f"halo_stroke_{index}"),
        make_transform(rotation_kfs=rotation_kfs),
    ]

    return make_shape_group(items, name=f"halo_{index}")


def build_network_layer(index):
    """Build one network path with line-drawing animation."""
    # Network paths: top→right, right→bottom, bottom→left, left→top
    # Cubic bezier control points from logo.svg
    beziers = [
        ((256, 130), (274, 202), (310, 238), (382, 256)),  # top→right
        ((382, 256), (310, 274), (274, 310), (256, 382)),  # right→bottom
        ((256, 382), (238, 310), (202, 274), (130, 256)),  # bottom→left
        ((130, 256), (202, 238), (238, 202), (256, 130)),  # left→top
    ]

    p0, p1, p2, p3 = beziers[index]
    pts = bezier_path(p0, p1, p2, p3)
    path_data = points_to_lottie_path(pts, closed=False)

    # Timing: each path draws in over 0.8s (24 frames), staggered by 0.4s (12 frames)
    # begin times: 0.2s, 0.6s, 1.0s, 1.4s → frames: 6, 18, 30, 42
    start_frame = 6 + index * 12
    end_frame = start_frame + 24

    items = [
        make_path(path_data, f"net_path_{index}"),
        make_stroke(NETWORK_COLOR, width=18, name=f"net_stroke_{index}"),
        make_trim(start_frame, end_frame, f"net_trim_{index}"),
        make_transform(),
    ]

    return make_shape_group(items, name=f"network_{index}")


def build_node_layer(index):
    """Build one node circle with fade-in animation."""
    pos = list(NODES[index])

    # Fade in: begin at 0.5s/0.9s/1.3s/1.7s → frames: 15/27/39/51
    # Duration: 0.3s = 9 frames
    begin_frame = 15 + index * 12
    end_frame = begin_frame + 9

    opacity_kfs = [
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": begin_frame},
        {"s": [100], "t": end_frame},
    ]

    # Circle as a path (ellipse approximation with 4 bezier segments)
    r = 16
    cx, cy = pos
    circle_pts = []
    for i in range(33):
        angle = 2 * math.pi * i / 32
        circle_pts.append([cx + r * math.cos(angle), cy + r * math.sin(angle)])
    path_data = points_to_lottie_path(circle_pts, closed=True)

    items = [
        make_path(path_data, f"node_path_{index}"),
        make_fill(NODE_COLOR, f"node_fill_{index}"),
        make_transform(opacity_kfs=opacity_kfs, position=[0, 0]),
    ]

    return make_shape_group(items, name=f"node_{index}")


def build_spark_layer():
    """Build the AI spark with fade-in and continuous pulse."""
    # Diamond path from logo.svg: 4 bezier curves forming a diamond/star
    # M256 198 C262 226 286 250 314 256 C286 262 262 286 256 314
    # C250 286 226 262 198 256 C226 250 250 226 256 198 Z
    pts = bezier_path((256, 198), (262, 226), (286, 250), (314, 256))
    pts += bezier_path((314, 256), (286, 262), (262, 286), (256, 314))
    pts += bezier_path((256, 314), (250, 286), (226, 262), (198, 256))
    pts += bezier_path((198, 256), (226, 250), (250, 226), (256, 198))
    path_data = points_to_lottie_path(pts, closed=True)

    # Fade in from 0→1 over 0.5s starting at 2.0s (frame 60)
    # Then continuous pulse: full→55%→full over 3s (90 frames), repeating
    opacity_kfs = [
        # Fade in
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": 60},
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [100], "t": 75},
        # Pulse cycle 1 (2.5s → 5.5s)
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [55], "t": 120},
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [100], "t": 165},
        # Pulse cycle 2 (5.5s → 8.5s)
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [55], "t": 210},
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [100], "t": 255},
        # Pulse cycle 3 (8.5s → 11.5s)
        {"i": {"x": [0.667], "y": [1]}, "o": {"x": [0.333], "y": [0]}, "s": [55], "t": 300},
        {"s": [100], "t": 345},
    ]

    items = [
        make_path(path_data, "spark_path"),
        make_fill(SPARK_COLOR, "spark_fill"),
        make_transform(opacity_kfs=opacity_kfs, position=[0, 0]),
    ]

    return make_shape_group(items, name="spark")


def build_lottie():
    """Build the complete Lottie JSON."""
    layers = []

    # Halo arcs (4) — each is a separate shape layer for rotation
    for i in range(4):
        # Each halo arc gets its own shape layer so rotation works independently
        arc_angles = [
            (-math.pi/2, -math.pi/2 + math.radians(78)),
            (0, math.radians(78)),
            (math.pi/2, math.pi/2 + math.radians(78)),
            (math.pi, math.pi + math.radians(78)),
        ]
        start_a, end_a = arc_angles[i]
        pts = arc_path(start_a, end_a)
        path_data = points_to_lottie_path(pts, closed=False)
        opacity = 100 if i % 2 == 0 else 85

        # Rotation: 0→360 over 1800 frames (60s @ 30fps)
        rotation_kfs = [
            {"i": {"x": [0.833], "y": [0.833]}, "o": {"x": [0.333], "y": [0]}, "s": [0], "t": 0},
            {"s": [360], "t": 1800},
        ]

        shape_items = [
            make_path(path_data, f"arc"),
            make_stroke(HALO_COLOR, width=18, name=f"stroke"),
            make_transform(
                rotation_kfs=rotation_kfs,
                opacity_kfs=None if opacity == 100 else [
                    {"s": [opacity], "t": 0},
                ],
            ),
        ]
        group = make_shape_group(shape_items, name=f"halo_{i}")

        layer = {
            "ddd": 0,
            "ind": i,
            "ty": 4,  # shape layer
            "nm": f"halo_{i}",
            "sr": 1,
            "ks": {
                "o": make_static_property(opacity),
                "r": {"a": 1, "k": rotation_kfs},
                "p": make_static_property([CX, CY, 0]),
                "a": make_static_property([0, 0, 0]),
                "s": make_static_property([100, 100, 100]),
            },
            "ao": 0,
            "shapes": [group],
            "ip": 0,
            "op": 1800,  # 60s @ 30fps
            "st": 0,
            "bm": 0,
        }
        layers.append(layer)

    # Network paths (4) — on a single shape layer with trim paths
    net_shapes = []
    for i in range(4):
        net_shapes.append(build_network_layer(i))
    # Add a transform at the end of shapes
    net_shapes.append(make_transform())

    net_layer = {
        "ddd": 0,
        "ind": 4,
        "ty": 4,
        "nm": "network",
        "sr": 1,
        "ks": {
            "o": make_static_property(100),
            "r": make_static_property(0),
            "p": make_static_property([0, 0, 0]),
            "a": make_static_property([0, 0, 0]),
            "s": make_static_property([100, 100, 100]),
        },
        "ao": 0,
        "shapes": net_shapes,
        "ip": 0,
        "op": 1800,
        "st": 0,
        "bm": 0,
    }
    layers.append(net_layer)

    # Nodes (4) — on a single shape layer
    node_shapes = []
    for i in range(4):
        node_shapes.append(build_node_layer(i))
    node_shapes.append(make_transform())

    node_layer = {
        "ddd": 0,
        "ind": 5,
        "ty": 4,
        "nm": "nodes",
        "sr": 1,
        "ks": {
            "o": make_static_property(100),
            "r": make_static_property(0),
            "p": make_static_property([0, 0, 0]),
            "a": make_static_property([0, 0, 0]),
            "s": make_static_property([100, 100, 100]),
        },
        "ao": 0,
        "shapes": node_shapes,
        "ip": 0,
        "op": 1800,
        "st": 0,
        "bm": 0,
    }
    layers.append(node_layer)

    # Spark — single shape layer
    spark_shapes = [build_spark_layer(), make_transform()]
    spark_layer = {
        "ddd": 0,
        "ind": 6,
        "ty": 4,
        "nm": "spark",
        "sr": 1,
        "ks": {
            "o": make_static_property(100),
            "r": make_static_property(0),
            "p": make_static_property([0, 0, 0]),
            "a": make_static_property([0, 0, 0]),
            "s": make_static_property([100, 100, 100]),
        },
        "ao": 0,
        "shapes": spark_shapes,
        "ip": 0,
        "op": 1800,
        "st": 0,
        "bm": 0,
    }
    layers.append(spark_layer)

    # Root composition
    lottie = {
        "v": "5.7.4",
        "fr": FPS,
        "ip": 0,
        "op": 1800,
        "w": WIDTH,
        "h": HEIGHT,
        "nm": "MultiAIEdit Logo",
        "ddd": 0,
        "assets": [],
        "layers": layers,
    }
    return lottie


def main():
    lottie = build_lottie()
    with open(LOTTIE_PATH, "w", encoding="utf-8") as f:
        json.dump(lottie, f, indent=2, ensure_ascii=False)
    size_kb = LOTTIE_PATH.stat().st_size // 1024
    print(f"✅ Saved {LOTTIE_PATH.name} ({size_kb}KB)")


if __name__ == "__main__":
    main()
