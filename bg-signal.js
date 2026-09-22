
(function initVoiceGuard3D() {
  const container = document.getElementById('threejs-canvas-container');
  if (!container || typeof THREE === 'undefined') return;

  const prefersReducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07090e, 0.024);

  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 1000);
  camera.position.set(0, 3.8, 22);
  camera.lookAt(0, 1.2, 0);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const colCyan = new THREE.Color(0x00f0ff);
  const colTeal = new THREE.Color(0x00e5a3);
  const colAlert = new THREE.Color(0xff2a5f);

  const createGlowTexture = () => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255, 255, 255, 1)');
    g.addColorStop(0.25, 'rgba(0, 240, 255, 0.9)');
    g.addColorStop(0.65, 'rgba(0, 229, 163, 0.3)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  };
  const glowTex = createGlowTexture();

  const waveCountX = 85;
  const waveCountZ = 75;
  const totalWavePoints = waveCountX * waveCountZ;
  const waveGeom = new THREE.BufferGeometry();
  const wavePos = new Float32Array(totalWavePoints * 3);
  const waveCols = new Float32Array(totalWavePoints * 3);

  let pIdx = 0;
  for (let i = 0; i < waveCountX; i++) {
    for (let j = 0; j < waveCountZ; j++) {
      const u = (i / (waveCountX - 1) - 0.5) * 85;
      const v = (j / (waveCountZ - 1) - 0.5) * 80;
      wavePos[pIdx * 3] = u;
      wavePos[pIdx * 3 + 1] = -4.5;
      wavePos[pIdx * 3 + 2] = v;

      const d = Math.sqrt(u * u + v * v) / 40;
      const c = d < 0.3 ? colCyan : (d < 0.65 ? colTeal : new THREE.Color(0x111b2e));
      waveCols[pIdx * 3] = c.r;
      waveCols[pIdx * 3 + 1] = c.g;
      waveCols[pIdx * 3 + 2] = c.b;
      pIdx++;
    }
  }
  waveGeom.setAttribute('position', new THREE.BufferAttribute(wavePos, 3));
  waveGeom.setAttribute('color', new THREE.BufferAttribute(waveCols, 3));

  const waveMat = new THREE.PointsMaterial({
    size: 0.38,
    vertexColors: true,
    map: glowTex,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const soundwaveMesh = new THREE.Points(waveGeom, waveMat);
  scene.add(soundwaveMesh);

  // Acoustic Wireframe Mesh
  const wireGeom = new THREE.PlaneGeometry(85, 80, 42, 38);
  wireGeom.rotateX(-Math.PI / 2);
  wireGeom.translate(0, -4.5, 0);
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0x00f0ff,
    wireframe: true,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending
  });
  const wireMesh = new THREE.Mesh(wireGeom, wireMat);
  scene.add(wireMesh);

  const coreGroup = new THREE.Group();
  coreGroup.position.set(0, 2.2, 0);
  scene.add(coreGroup);

  const voiceCoreGeom = new THREE.IcosahedronGeometry(3.0, 2);
  const voiceCoreMat = new THREE.MeshBasicMaterial({
    color: 0x00f0ff,
    wireframe: true,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending
  });
  const voiceCore = new THREE.Mesh(voiceCoreGeom, voiceCoreMat);
  coreGroup.add(voiceCore);

  const innerAcousticGeom = new THREE.OctahedronGeometry(1.9, 0);
  const innerAcousticMat = new THREE.MeshLambertMaterial({
    color: 0x031726,
    emissive: 0x00e5a3,
    transparent: true,
    opacity: 0.75
  });
  const innerAcousticCore = new THREE.Mesh(innerAcousticGeom, innerAcousticMat);
  coreGroup.add(innerAcousticCore);

  const ringMatCyan = new THREE.MeshBasicMaterial({
    color: 0x00f0ff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });
  const ringMatTeal = new THREE.MeshBasicMaterial({
    color: 0x00e5a3,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });

  const ring1 = new THREE.Mesh(new THREE.RingGeometry(4.6, 4.75, 64), ringMatCyan);
  ring1.rotation.x = Math.PI / 2.2;
  coreGroup.add(ring1);

  const ring2 = new THREE.Mesh(new THREE.RingGeometry(5.8, 5.92, 48), ringMatTeal);
  ring2.rotation.x = -Math.PI / 2.6;
  ring2.rotation.y = Math.PI / 6;
  coreGroup.add(ring2);

  // Concentric Equalizer Rings
  const eqRings = [];
  for (let e = 0; e < 3; e++) {
    const rad = 6.8 + e * 1.4;
    const eqGeom = new THREE.RingGeometry(rad, rad + 0.08, 64);
    const eqMat = new THREE.MeshBasicMaterial({
      color: e === 1 ? 0x00e5a3 : 0x00f0ff,
      transparent: true,
      opacity: 0.22 - e * 0.05,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const rMesh = new THREE.Mesh(eqGeom, eqMat);
    rMesh.rotation.x = Math.PI / 2;
    coreGroup.add(rMesh);
    eqRings.push(rMesh);
  }

  const barCount = 48;
  const barGroup = new THREE.Group();
  const bars = [];
  const radiusCircle = 8.5;

  for (let b = 0; b < barCount; b++) {
    const angle = (b / barCount) * Math.PI * 2;
    const bx = Math.cos(angle) * radiusCircle;
    const bz = Math.sin(angle) * radiusCircle;

    const bGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(bx, -4.5, bz),
      new THREE.Vector3(bx, -1.0, bz)
    ]);

    const isCyan = b % 2 === 0;
    const bMat = new THREE.LineBasicMaterial({
      color: isCyan ? colCyan : colTeal,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending
    });
    const bLine = new THREE.Line(bGeom, bMat);
    barGroup.add(bLine);
    bars.push({ line: bLine, angle, freqOffset: Math.random() * 10 });
  }
  scene.add(barGroup);

  const nodeCount = 180;
  const nodeGeom = new THREE.BufferGeometry();
  const nodePos = new Float32Array(nodeCount * 3);
  const nodeCols = new Float32Array(nodeCount * 3);

  for (let n = 0; n < nodeCount; n++) {
    nodePos[n * 3] = (Math.random() - 0.5) * 55;
    nodePos[n * 3 + 1] = -3 + Math.random() * 14;
    nodePos[n * 3 + 2] = (Math.random() - 0.5) * 45;

    const rand = Math.random();
    const c = rand > 0.6 ? colCyan : (rand > 0.25 ? colTeal : colAlert);
    nodeCols[n * 3] = c.r;
    nodeCols[n * 3 + 1] = c.g;
    nodeCols[n * 3 + 2] = c.b;
  }
  nodeGeom.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  nodeGeom.setAttribute('color', new THREE.BufferAttribute(nodeCols, 3));

  const nodeMat = new THREE.PointsMaterial({
    size: 0.42,
    vertexColors: true,
    map: glowTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const nodes = new THREE.Points(nodeGeom, nodeMat);
  scene.add(nodes);

  scene.add(new THREE.AmbientLight(0x0a1020, 1.8));
  const pLight1 = new THREE.PointLight(0x00f0ff, 3.2, 45);
  pLight1.position.set(0, 5, 6);
  scene.add(pLight1);

  let targetX = 0, targetY = 3.8;
  if (!prefersReducedMotion) {
    window.addEventListener('mousemove', (e) => {
      const mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      const mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
      targetX = mouseX * 2.8;
      targetY = 3.8 + mouseY * 1.5;
    });
  }

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (prefersReducedMotion) renderer.render(scene, camera);
  };
  window.addEventListener('resize', onResize);

  if (prefersReducedMotion) {
    // Render one still frame — no continuous rAF loop.
    renderer.render(scene, camera);
    return;
  }

  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // Parallax easing
    camera.position.x += (targetX - camera.position.x) * 0.045;
    camera.position.y += (targetY - camera.position.y) * 0.045;
    camera.lookAt(0, 1.5, 0);

    // Holographic Core Rotations
    coreGroup.position.y = 2.2 + Math.sin(t * 1.1) * 0.32;
    voiceCore.rotation.y = t * 0.25;
    voiceCore.rotation.z = Math.sin(t * 0.2) * 0.15;

    innerAcousticCore.rotation.y = -t * 0.4;
    innerAcousticCore.rotation.x = Math.cos(t * 0.25) * 0.2;

    ring1.rotation.z = t * 0.3;
    ring2.rotation.z = -t * 0.25;

    eqRings.forEach((r, i) => {
      r.rotation.z = t * (0.15 * (i % 2 === 0 ? 1 : -1));
      const pulse = 1.0 + Math.sin(t * 2.5 + i * 1.2) * 0.035;
      r.scale.set(pulse, pulse, pulse);
    });

    // Dynamic Harmonic Audio Wavefield
    const fPos = soundwaveMesh.geometry.attributes.position.array;
    let idx = 0;
    for (let i = 0; i < waveCountX; i++) {
      for (let j = 0; j < waveCountZ; j++) {
        const u = fPos[idx * 3];
        const w = fPos[idx * 3 + 2];
        const d = Math.sqrt(u * u + w * w);

        const fundamental = Math.sin(u * 0.22 - t * 2.2) * 0.55;
        const harmonic = Math.cos(w * 0.28 + t * 1.8) * Math.sin(d * 0.18 - t * 1.4) * 0.45;
        const ripple = Math.sin(d * 0.35 - t * 3.0) * 0.3;

        fPos[idx * 3 + 1] = -4.5 + fundamental + harmonic + ripple;
        idx++;
      }
    }
    soundwaveMesh.geometry.attributes.position.needsUpdate = true;

    // Wireframe deformation
    const wPos = wireMesh.geometry.attributes.position.array;
    for (let i = 0; i < wPos.length / 3; i++) {
      const x = wireGeom.attributes.position.array[i * 3];
      const z = wireGeom.attributes.position.array[i * 3 + 2];
      const d = Math.sqrt(x * x + z * z);
      wPos[i * 3 + 1] = -4.5 + Math.sin(x * 0.22 - t * 2.2) * 0.55 + Math.cos(z * 0.28 + t * 1.8) * Math.sin(d * 0.18 - t * 1.4) * 0.45;
    }
    wireMesh.geometry.attributes.position.needsUpdate = true;

    // Animate frequency equalizer bars
    for (let b = 0; b < bars.length; b++) {
      const bar = bars[b];
      const p = bar.line.geometry.attributes.position.array;
      const heightMod = 1.2 + Math.sin(t * 4.0 + bar.freqOffset) * 1.8 + Math.cos(t * 2.5 + bar.angle * 3.0) * 1.2;
      p[4] = -4.5 + Math.max(0.6, heightMod);
      bar.line.geometry.attributes.position.needsUpdate = true;
    }

    nodes.rotation.y = t * 0.03;
    nodes.position.y = Math.sin(t * 0.6) * 0.3;

    renderer.render(scene, camera);
  }
  animate();
})();