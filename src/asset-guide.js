const topics = {
  workflow: {
    steps: [
      'Describe the subject, the mobile viewport, and what the user should read first.',
      'Draw one resting silhouette at actual phone size. Block large shapes first. Add contours, small details, and a light direction once the silhouette reads.',
      'Draw the important poses before adding in-betweens. Use a shared pivot for connected parts and hold the endpoint long enough to read.',
      'Wire game or app inputs to named states. Place visual cues on state entry. Keep score, answers, ammo and other authoritative data in the host.',
      'Run asset check, replay repeated and interrupted inputs with asset trace, then open selected asset frame SVGs and refine.',
      'Run asset pack and pass the resulting file text to MotionPlayer from skia-motion-agentic-cli/runtime/mobile.',
    ],
    examples: ['skac asset sample versus-hud', 'skac asset sample game-hud', 'skac asset sample sprout'],
    topics: ['format', 'hud', 'character', 'lighting', 'feathering', 'images', 'mesh', 'masking', 'attachments', 'layout'],
  },
  format: {
    schema: 'skac.asset/1',
    units: { artboard: 'points with origin at top left', clips: 'milliseconds', 'trace times': 'milliseconds', '--commands': 'seconds', rotation: 'degrees' },
    root: {
      name: 'identifier',
      artboard: '{width,height,nodes}',
      channels: 'numeric defaults keyed by channel name',
      clips: '{clipName:{ms,reducedAt?,tracks:{channelName:[[ms,value,ease?],...]}}}',
      machine: 'skac.machine/1 with frame-clock layers and host input',
      markers: '[{name,layer,state}]',
      images: 'optional map of image names to embedded PNG or WebP data URIs',
      attachments: 'optional [{from,to,maxDistance}] checks for named group points and mesh pins',
    },
    drawOrder: 'Nodes and group children draw from first to last.',
    nodeTypes: {
      ellipse: { kind: 'ellipse', x: 36, y: 18, width: 96, height: 96, fill: '#EDECAB' },
      roundRect: { kind: 'roundRect', x: 12, y: 12, width: 'fillWidth', height: 12, radius: 6, fill: '#78E7C1' },
      path: { kind: 'path', fill: '#263344', commands: [['M', 0, 0], ['Q', 12, -20, 24, 0], ['Z']] },
      image: { kind: 'image', image: 'face', x: 12, y: 10, width: 80, height: 120, opacity: 'faceAlpha' },
      mesh: { kind: 'mesh', image: 'face', vertices: [[0, 0, 0, 0], [20, 0, 1, 0], [0, 20, 0, 1]], indices: [0, 1, 2] },
      group: { kind: 'group', x: 45, y: 52, scaleX: 1, scaleY: 1, rotation: 'tilt', children: [] },
    },
    rules: [
      'Numeric draw properties and geometry can reference declared channels by name.',
      'Shape opacity is optional. Colors use #RRGGBB or #RRGGBBAA.',
      'Add feather to an ellipse, roundRect or path to soften its edge. Give it a radius from 0 to 64 in artboard points or name a numeric channel.',
      'Paths use absolute M, L, Q, C and Z commands. Coordinates can read declared channels. A group rotates and scales around its local origin.',
      'A group can have clip, an array of closed or implicitly closed path commands in its local coordinates. It clips every descendant layer.',
      'An anchor on a top-level group pins it to a viewport edge as the viewport gains extra space.',
      'Keyframes increase in time. Use linear, in, out or inOut on the destination keyframe. Use hold for an instant swap at that key.',
      'Use ms:0 and one keyframe for a static pose. A later machine layer overrides earlier channels it writes.',
      'Choose reducedAt in ms for a meaningful still from a clip. The machine still advances through the same states.',
      'Markers fire upon entry after asset initialization. Host input events at the same timestamp are one batch.',
    ],
    machine: { inputs: ['boolean', 'number', 'enum', 'trigger'], triggerCondition: ['reload'], thresholdCondition: ['health', '<=', 0.25], afterClip: { from: 'reloading', to: 'ready', exit_at: 1 } },
  },
  hud: {
    drawing: [
      'Decide which value needs to be seen during play. Give it the largest visual area and a stable alignment.',
      'Draw a panel, the empty meters, and their fills at full size. Reserve space for native labels inside the app safe area.',
      'Give a warning its own icon or outline. Check that it reads in grayscale.',
      'Bind from app data with static poses at the ends of the range. Test empty, low, full, repeated reload, and cancel.',
    ],
    commands: [
      'skac asset sample game-hud',
      'skac asset trace game-hud.motion.json --trace=0,520,950,1400 --commands "health=0.2@0.1 ammo=2@0.1 reload@0.25"',
      'skac asset frame game-hud.motion.json --trace=520 --commands "health=0.2@0.1 ammo=2@0.1 reload@0.25"',
      'skac asset sample versus-hud',
    ],
  },
  character: {
    drawing: [
      'Choose a reference size and draw in profile or front view with one clear silhouette.',
      'Build the large masses with ovals or paths. Group connected parts and set the body pivot at its contact point.',
      'Change the eyes and mouth before the weight shifts. Sketch a rest, anticipation, peak, and landing pose.',
      'Check the resting silhouette, the peak of the reaction, and the interrupted pose at actual display size.',
      'For a painted character, keep the source textures. Put parts that bend on meshes and mount details like eyes and a bill hinge on mesh pins. Run skac asset guide mesh.',
    ],
    commands: [
      'skac asset sample sprout',
      'skac asset trace sprout.motion.json --trace=0,260,600,1300 --commands "correct@0.1 incorrect@0.2 correct@0.3 light=1@0.4"',
      'skac asset frame sprout.motion.json --trace=300 --commands "correct@0.1 light=1@0.25"',
    ],
  },
  lighting: {
    drawing: [
      'Choose a material and light direction before choosing colors. Keep the cool shadow and warm highlight readable at phone size.',
      'Place the radial center off-center. Name its x or y channel and bind a machine blend to the host light input.',
      'The light center follows its group transform. Drive the input from game state or a gesture and compare both ends of its range.',
    ],
    fill: { kind: 'radial', x: 'lightX', y: -83, radius: 108, colors: ['#FFFAC1', '#D88A40'] },
    example: 'skac asset frame sprout.motion.json --trace=120 --commands "light=1@0.1"',
  },
  feathering: {
    drawing: [
      'Add feather: 6 to a filled path, rounded rectangle or ellipse to soften its edge. 0 gives a sharp edge.',
      'For a glow, draw a feathered copy beneath the sharp foreground shape. For a shadow, place a darker copy in an offset group.',
      'For an impact, animate a channel used by feather and a separate opacity channel. Widen the soft edge as the highlight fades. Leave room for the edge inside the artboard.',
      'Use a steady cue or no flash under reduced motion. Keep critical meter edges sharp and confirm the effect at phone size.',
    ],
    shape: { kind: 'roundRect', x: 20, y: 20, width: 148, height: 16, radius: 4, fill: '#75E7CC', opacity: 0.4, feather: 6 },
    commands: [
      'skac asset sample versus-hud',
      'skac asset frame versus-hud.motion.json --trace=230 --commands "leftHealth=0.48@0.1 leftHit@0.1"',
    ],
  },
  images: {
    drawing: [
      'Use static artwork. Run skac asset image art.webp. Put the returned uri in images under a short name such as face.',
      'For a smaller texture, pass --size=160x160 to fit within the pixel dimensions without upscaling. Image node coordinates stay in artboard points.',
      'Reference that name from an image node sized in artboard points. Use its original aspect ratio to avoid stretching the painting.',
      'Place the image inside a group whose origin is the part\'s hinge or contact point. Animate the group transform and the image opacity.',
      'Use hold for crisp sprite swaps or inOut opacity keys to blend between adjacent paintings.',
      'To show only part of a painting, wrap the image in a group with a clip path. Keep soft alpha edges in the painting.',
      'Preview the composited artwork with asset frame. The packed file includes its pixels and must fit the 1 MiB asset limit.',
    ],
    layer: { kind: 'image', image: 'face', x: -40, y: -100, width: 80, height: 120, opacity: 'faceAlpha' },
  },
  masking: {
    drawing: [
      'Draw the visible contour as a group clip path using its local coordinates.',
      'Place images, vector shapes or nested groups inside. The entire group is visible only within the path.',
      'Animate a channel on the path coordinates to reveal a fill, follow a moving lid, or morph the opening.',
      'For a painted joint with a soft seam, keep the transparency in the embedded image. The group clip cuts at a geometric edge.',
    ],
    channels: { fillEdge: 60 },
    group: {
      kind: 'group',
      clip: [['M', 0, 0], ['L', 'fillEdge', 0], ['L', 'fillEdge', 16], ['L', 0, 16], ['Z']],
      children: [{ kind: 'roundRect', x: 0, y: 0, width: 120, height: 16, radius: 8, fill: '#78E7C1' }],
    },
  },
  mesh: {
    drawing: [
      'Embed a PNG or WebP with skac asset image, then reference its name from a mesh node.',
      'Each vertex is [x,y,u,v]. x and y are artboard coordinates or numeric channels. u and v are fixed texture coordinates from 0 to 1, measured from the upper left.',
      'Each triple in indices draws one triangle. Share vertices along connected edges. Give every triangle an area in texture space.',
      'Animate just the vertices that bend. Pose tracks move their x and y without changing the underlying texture.',
      'A pin belongs to a zero-based triangle. Its weights are ordered like that triangle’s indices and sum to 1.',
      'Optional pin children translate with the pin. Use a child group to animate their rotation. The mesh opacity controls the texture, and each child controls its own opacity.',
      'Replay movement with asset trace and compare a pin with another named point using attachments. Render key poses with asset frame before packing.',
    ],
    channels: { browY: 0 },
    node: {
      kind: 'mesh', image: 'face',
      vertices: [[0, 0, 0, 0], [60, 'browY', 1, 0], [0, 60, 0, 1], [60, 60, 1, 1]],
      indices: [0, 1, 2, 1, 3, 2],
      pins: {
        eyeSocket: {
          triangle: 0, weights: [0.2, 0.6, 0.2],
          children: [{ kind: 'ellipse', x: -3, y: -3, width: 6, height: 6, fill: '#261D19' }],
        },
      },
    },
  },
  attachments: {
    drawing: [
      'Give each point a unique name. Store it on the group whose transform the point follows.',
      'A named mesh pin is also an attachment point. It follows the triangle as its vertices move.',
      'Use group-local coordinates or declared channels for x and y.',
      'Add an attachment rule to limit the distance between two points in artboard units.',
      'Replay the input cue and sample the whole motion with asset check. On failure, it reports the greatest sampled gap and its time for the first failing rule.',
      'Inspect sampled positions with asset trace. Pass --size to check viewport anchors at the intended display size.',
    ],
    group: { kind: 'group', points: { flameCentre: { x: 0, y: -24 } }, children: [] },
    attachments: [{ from: 'flameCentre', to: 'glowCentre', maxDistance: 2 }],
    commands: [
      'skac asset check lamp.motion.json --trace=0:2400:16 --commands=surge@0',
      'skac asset trace lamp.motion.json --trace=0,800,1000 --commands=surge@0',
    ],
  },
  layout: {
    drawing: [
      'Set artboard width and height for the drawing coordinates. The app supplies the display size through React Native styles or optional width and height props.',
      'Draw the resting layout at the reference size. Put each panel in a top-level group and give it an anchor.',
      'Use x: left, center or right and y: top, center or bottom. Anchors keep the authored edge margin while the viewport gains extra space.',
      'Preview a wide and a tall viewport. Put separate controls in React Native when the screen needs to rearrange rows or columns.',
    ],
    group: { kind: 'group', x: 16, y: 12, anchor: { x: 'left', y: 'top' }, children: [] },
    commands: [
      'skac asset sample versus-hud',
      'skac asset frame versus-hud.motion.json --size=1200x144 --out=wide.svg',
      'skac asset frame versus-hud.motion.json --size=700x320 --out=tall.svg',
    ],
  },
};

export function assetGuide(topic = 'workflow') {
  return Object.hasOwn(topics, topic) ? { ok: true, topic, ...topics[topic] } : null;
}
