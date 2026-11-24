"""Blender setup shared by the distant-city and water-level survey bakes."""
import bpy


def survey_scene(model):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = False
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_percentage = 100
    return scene


def survey_pass(scene, distance=None, scale=1, bits=8):
    """Use the source photograph, or linear camera depth divided by scale."""
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        tree = material.node_tree
        output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
        source = next((n for n in tree.nodes if n.type == "TEX_IMAGE" and n.image), None)
        if output is None or source is None:
            continue
        emission = tree.nodes.new("ShaderNodeEmission")
        if distance:
            camera = tree.nodes.new("ShaderNodeCameraData")
            scaled = tree.nodes.new("ShaderNodeMath")
            scaled.operation = "DIVIDE"
            scaled.inputs[1].default_value = scale
            tree.links.new(camera.outputs[distance], scaled.inputs[0])
            colour = scaled.outputs[0]
        else:
            colour = source.outputs["Color"]
        tree.links.new(colour, emission.inputs["Color"])
        tree.links.new(emission.outputs[0], output.inputs["Surface"])
    scene.view_settings.view_transform = "Raw" if distance else "Standard"
    scene.render.image_settings.color_mode = "BW" if bits == 16 else "RGBA"
    scene.render.image_settings.color_depth = str(bits)
