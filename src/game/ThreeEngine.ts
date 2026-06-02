import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ThemeColors, TILE_SIZE, WALL_HEIGHT, EngineMode, isBossLevel, chapterForLevel, waveConfigForWave, PickupType, PICKUP_CONFIGS, rollPickupType, EnemyType, ENEMY_CONFIGS, rollEnemyTypeForWave, rollEnemyTypeForLevel } from '../types';
import { Maze } from './Maze';
import { AudioEngine } from './Audio';

export class ThreeEngine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  maze: Maze;
  playerObj: THREE.Group;
  clock: THREE.Clock;
  theme: ThemeColors;
  
  // Game state
  player = { x: 0, y: 0, hp: 3, timer: 240, score: 0, ammo: 12 };
  level = 1;
  mode: EngineMode = 'survival';
  static readonly MAX_AMMO = 20;
  static readonly AMMO_PER_CORRECT = 6;

  // Heart Defense state
  heart: { hp: number; maxHp: number; mesh: THREE.Group | null; position: THREE.Vector3 } = {
    hp: 10, maxHp: 10, mesh: null, position: new THREE.Vector3(0, 0.7, 0),
  };
  private units: { mesh: THREE.Mesh; angle: number; speed: number; lastFire: number; hp: number; huntTarget: any }[] = [];
  enemiesKilled = 0;
  unitsBuilt = 0;

  // Wave system (Heart Defense + Tower Defense)
  waveNumber = 0;
  waveActive = false;
  enemiesRemainingThisWave = 0; // not yet spawned
  private currentWaveSize = 0;  // total enemies for the current wave
  private waveSpawnTimer = 0;
  private waveSpawnInterval = 0.8;
  private waveCurrentSpeed = 2.0;
  private waveLullDuration = 4.0; // seconds between waves
  private waveLullTimer = 0;
  private isWaveMode = false;
  onWaveStart?: (wave: number) => void;
  onWaveEnd?: (wave: number) => void;

  // Pickup / exploration system (wave modes only)
  private pickups: { group: THREE.Group; type: PickupType; gridX: number; gridY: number; spawnedAt: number }[] = [];
  private pickupDripTimer = 0;
  private static readonly PICKUP_DRIP_INTERVAL = 12;
  private static readonly MAX_PICKUPS = 6;
  lastPickupCollected: { type: PickupType; label: string; at: number } | null = null;
  keys: { [key: string]: boolean } = {};
  touchVector = { x: 0, z: 0 };
  onQuizTrigger: (type: 'door' | 'tower', data: any) => void;
  onStateUpdate?: (state: any) => void;
  onLevelComplete?: (finalScore: number) => void;

  cameraMode: 'follow' | 'top' | 'tactical' | 'bird' | 'cinematic' = 'follow';
  /** Fog assigned at construction; we toggle it on/off based on camera mode. */
  private baseFog!: THREE.FogExp2;

  // Lifecycle / external locks
  quizLocked = false;
  paused = false;
  private hitStopUntil = 0; // engine.clock time at which simulation resumes
  private floatTexts: { sprite: THREE.Sprite; ttl: number; lifeTotal: number }[] = [];
  private running = true;
  private animationId: number | null = null;
  private container: HTMLDivElement;
  private boundResize: () => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;

  // Rising-edge trigger guard. A door QCM only opens when the player ENTERS the door's
  // proximity radius — staying inside it doesn't re-fire. After a wrong answer, the player
  // must step out and back in to retry. Vastly less surprising than a silent cooldown.
  private inTriggerRange: Set<string> = new Set();

  // Player physical radius (smaller than half-tile so they can fit through doorways)
  private static readonly PLAYER_RADIUS = 0.55;

  // The tower spot the player is currently standing on (for opt-in build via E)
  nearTowerSpot: { x: number; y: number; occupied: boolean } | null = null;

  // Player shooting
  private playerLastFire = 0;
  private static readonly PLAYER_FIRE_COOLDOWN = 0.3;
  private static readonly PLAYER_FIRE_RANGE = 16;

  // Level-based tuning
  private waveInterval = 5;
  private enemyBaseSpeed = 2.0;
  private hasExited = false;

  constructor(
    container: HTMLDivElement,
    maze: Maze,
    theme: ThemeColors,
    onQuizTrigger: (type: 'door' | 'tower', data: any) => void,
    onStateUpdate?: (state: any) => void,
    options?: {
      mode?: EngineMode;
      level?: number;
      startScore?: number;
      startTimer?: number;
      startHp?: number;
      startAmmo?: number;
      onLevelComplete?: (s: number) => void;
      onWaveStart?: (wave: number) => void;
      onWaveEnd?: (wave: number) => void;
    }
  ) {
    this.maze = maze;
    this.theme = theme;
    this.container = container;
    this.onQuizTrigger = onQuizTrigger;
    this.onStateUpdate = onStateUpdate;
    this.clock = new THREE.Clock();

    this.mode = options?.mode ?? 'survival';
    this.level = Math.max(1, options?.level ?? 1);
    this.player.score = options?.startScore ?? 0;
    this.player.timer = options?.startTimer ?? 240;
    this.player.hp = options?.startHp ?? 3;
    this.player.ammo = options?.startAmmo ?? 12;
    this.onLevelComplete = options?.onLevelComplete;

    // Difficulty curve depends on mode
    if (this.mode === 'sprint') {
      this.waveInterval = Number.POSITIVE_INFINITY; // disable spawning
      this.isWaveMode = false;
    } else if (this.mode === 'heart_defense' || this.mode === 'tower_defense') {
      // Structured wave mode: enemies arrive in groups, with lulls between waves
      this.isWaveMode = true;
      this.waveLullTimer = 0;
      this.waveLullDuration = 3.5; // initial breathing room before wave 1
      this.waveNumber = 0;
      this.waveActive = false;
      this.enemyBaseSpeed = 2.0;
    } else {
      // Survival: continuous spawn, scales with level
      this.isWaveMode = false;
      this.waveInterval = Math.max(1.6, 5 - (this.level - 1) * 0.6);
      this.enemyBaseSpeed = 2.0 + (this.level - 1) * 0.4;
      if (isBossLevel(this.level)) {
        this.waveInterval = Math.max(1.2, this.waveInterval * 0.7);
        this.enemyBaseSpeed *= 1.2;
      }
    }

    this.onWaveStart = options?.onWaveStart;
    this.onWaveEnd = options?.onWaveEnd;

    // Scene — fog density slightly increases per chapter for a sense of "deeper" infiltration
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.theme.bgDark);
    const baseFog = 0.04;
    const chapterFogBoost = Math.min(0.04, (Math.max(1, options?.level ?? 1) - 1) * 0.006);
    const bossExtra = isBossLevel(options?.level ?? 1) ? 0.02 : 0;
    this.baseFog = new THREE.FogExp2(this.theme.bgDark, baseFog + chapterFogBoost + bossExtra);
    this.scene.fog = this.baseFog;

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Shadows are expensive and we have few lights — disable to keep frame budget tight
    this.renderer.shadowMap.enabled = false;
    container.appendChild(this.renderer.domElement);

    // Lights
    const ambient = new THREE.AmbientLight(0x404040, 1.5);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(this.theme.primaryLight, 1.2);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    this.scene.add(sun);

    // Player Mesh
    this.playerObj = new THREE.Group();
    const bodyGeo = new THREE.SphereGeometry(0.5, 16, 16);
    const bodyMat = new THREE.MeshStandardMaterial({ 
        color: this.theme.primaryLight, 
        emissive: this.theme.primary, 
        emissiveIntensity: 0.5 
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    this.playerObj.add(body);
    
    const eyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0.2, 0.2, 0.35);
    this.playerObj.add(eye);
    const eye2 = eye.clone();
    eye2.position.x = -0.2;
    this.playerObj.add(eye2);

    this.scene.add(this.playerObj);

    this.initMaze();
    this.initNetworkBackground();

    // Spawn player at maze entry tile
    const entryX = (this.maze.entry.x - this.maze.width / 2) * TILE_SIZE;
    const entryZ = (this.maze.entry.y - this.maze.height / 2) * TILE_SIZE;
    this.playerObj.position.set(entryX, 0.5, entryZ);

    this.boundResize = this.onResize.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundKeyUp = this.onKeyUp.bind(this);
    this.setupControls();

    window.addEventListener('resize', this.boundResize);

    // Wave modes get initial pickups so the player has something to explore for
    // during the first lull, before wave 1 starts
    if (this.isWaveMode) {
      for (let i = 0; i < 2; i++) this.spawnPickup();
    }
  }

  private initNetworkBackground() {
    const count = 40;
    const nodes: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push(new THREE.Vector3(
        (Math.random() - 0.5) * 400,
        (Math.random() - 0.5) * 200,
        (Math.random() - 0.5) * 400
      ));
    }

    const bgGroup = new THREE.Group();

    const ptsGeo = new THREE.BufferGeometry().setFromPoints(nodes);
    const ptsMat = new THREE.PointsMaterial({
      color: this.theme.primaryLight,
      size: 0.8,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    bgGroup.add(new THREE.Points(ptsGeo, ptsMat));

    // Lines merged into one geometry (one draw call instead of N)
    const linePositions: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[i].distanceTo(nodes[j]) < 60) {
          linePositions.push(nodes[i].x, nodes[i].y, nodes[i].z, nodes[j].x, nodes[j].y, nodes[j].z);
        }
      }
    }
    if (linePositions.length > 0) {
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: this.theme.primary,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      bgGroup.add(new THREE.LineSegments(lineGeo, lineMat));
    }

    this.scene.add(bgGroup);
    this.onUpdateRoutines.push((t) => {
      bgGroup.rotation.y = t * 0.05;
      bgGroup.position.y = Math.sin(t * 0.2) * 5;
    });
  }

  private initMaze() {
    const floorGeo = new THREE.PlaneGeometry(this.maze.width * TILE_SIZE, this.maze.height * TILE_SIZE);
    const floorMat = new THREE.MeshStandardMaterial({
      color: this.theme.floor,
      roughness: 0.8,
      metalness: 0.2,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Grid helper for tech feel
    const grid = new THREE.GridHelper(200, 50, this.theme.border, this.theme.border);
    (grid.material as THREE.LineBasicMaterial).transparent = true;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.15;
    grid.position.y = 0.01;
    this.scene.add(grid);

    // Collect wall and strip geometries to merge — one draw call instead of one per tile
    const wallGeos: THREE.BufferGeometry[] = [];
    const stripGeos: THREE.BufferGeometry[] = [];
    const wallTemplate = new THREE.BoxGeometry(TILE_SIZE, WALL_HEIGHT, TILE_SIZE);
    const stripTemplate = new THREE.BoxGeometry(TILE_SIZE * 1.01, 0.1, TILE_SIZE * 1.01);
    const ringAnimRefs: { ring: THREE.Mesh; spot: THREE.Mesh & { material: THREE.MeshStandardMaterial } }[] = [];
    const doorIndicatorRefs: { mesh: THREE.Mesh; doorKey: string }[] = [];

    for (let y = 0; y < this.maze.height; y++) {
      for (let x = 0; x < this.maze.width; x++) {
        const tile = this.maze.grid[y][x];
        const px = (x - this.maze.width / 2) * TILE_SIZE;
        const pz = (y - this.maze.height / 2) * TILE_SIZE;

        if (tile === 1) {
          const w = wallTemplate.clone().translate(px, WALL_HEIGHT / 2, pz);
          wallGeos.push(w);
          const s = stripTemplate.clone().translate(px, WALL_HEIGHT * 0.8, pz);
          stripGeos.push(s);
        } else if (tile === 2) {
          // Determine the axis the door spans along (corridor 'h' or 'v')
          const axis = this.maze.corridorAxisAt(x, y);

          // Pillars on each side of the doorway (neon-glow border)
          const pillarGeo = new THREE.BoxGeometry(0.3, WALL_HEIGHT, 0.3);
          const pillarMat = new THREE.MeshStandardMaterial({
            color: this.theme.borderBright,
            emissive: this.theme.primary,
            emissiveIntensity: 0.6,
            metalness: 0.8,
            roughness: 0.2,
          });
          const offset = TILE_SIZE / 2 - 0.15;
          const pillarA = new THREE.Mesh(pillarGeo, pillarMat);
          const pillarB = new THREE.Mesh(pillarGeo, pillarMat);
          if (axis === 'h') {
            // Corridor runs East-West → pillars on North & South sides
            pillarA.position.set(px, WALL_HEIGHT / 2, pz - offset);
            pillarB.position.set(px, WALL_HEIGHT / 2, pz + offset);
          } else {
            pillarA.position.set(px - offset, WALL_HEIGHT / 2, pz);
            pillarB.position.set(px + offset, WALL_HEIGHT / 2, pz);
          }
          this.scene.add(pillarA);
          this.scene.add(pillarB);

          // Top arch / lintel
          const lintelGeo = new THREE.BoxGeometry(
            axis === 'v' ? TILE_SIZE : 0.3,
            0.3,
            axis === 'h' ? TILE_SIZE : 0.3
          );
          const lintel = new THREE.Mesh(lintelGeo, pillarMat);
          lintel.position.set(px, WALL_HEIGHT - 0.15, pz);
          this.scene.add(lintel);

          // The door panel itself (red, glows, slides down when answered correctly)
          const panelW = axis === 'v' ? TILE_SIZE * 0.85 : 0.2;
          const panelD = axis === 'h' ? TILE_SIZE * 0.85 : 0.2;
          const doorGeo = new THREE.BoxGeometry(panelW, WALL_HEIGHT * 0.85, panelD);
          const doorMat = new THREE.MeshStandardMaterial({
            color: this.theme.red,
            emissive: this.theme.red,
            emissiveIntensity: 0.6,
            transparent: true,
            opacity: 0.85,
          });
          const door = new THREE.Mesh(doorGeo, doorMat);
          door.position.set(px, WALL_HEIGHT * 0.45, pz);
          door.name = `door_${x}_${y}`;
          this.scene.add(door);

          // Floating "?" indicator above closed doors (icosahedron that pulses)
          const indGeo = new THREE.IcosahedronGeometry(0.25, 0);
          const indMat = new THREE.MeshBasicMaterial({
            color: this.theme.amber,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const indicator = new THREE.Mesh(indGeo, indMat);
          indicator.position.set(px, WALL_HEIGHT + 0.7, pz);
          indicator.name = `door_ind_${x}_${y}`;
          this.scene.add(indicator);
          doorIndicatorRefs.push({ mesh: indicator, doorKey: `${x},${y}` });
        } else if (tile === 3) {
          const spotGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.1, 6);
          const spotMat = new THREE.MeshStandardMaterial({
            color: this.theme.bgDark,
            emissive: this.theme.primary,
            emissiveIntensity: 0.2,
            metalness: 0.9,
            roughness: 0.1,
            transparent: true,
            opacity: 0.8,
          });
          const spot = new THREE.Mesh(spotGeo, spotMat);
          spot.position.set(px, 0.05, pz);
          this.scene.add(spot);

          const ringGeo = new THREE.TorusGeometry(0.8, 0.08, 8, 16);
          const ringMat = new THREE.MeshBasicMaterial({
            color: this.theme.primaryLight,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.set(px, 0.5, pz);
          this.scene.add(ring);

          ringAnimRefs.push({ ring, spot: spot as any });
        } else if (tile === 4) {
          // Entry pad — circular disc with neon ring so players see where they spawned
          const padGeo = new THREE.CircleGeometry(1.4, 24);
          const padMat = new THREE.MeshBasicMaterial({
            color: this.theme.primary,
            transparent: true,
            opacity: 0.35,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const pad = new THREE.Mesh(padGeo, padMat);
          pad.rotation.x = -Math.PI / 2;
          pad.position.set(px, 0.02, pz);
          this.scene.add(pad);
          const ringGeo = new THREE.RingGeometry(1.3, 1.5, 24);
          const ring = new THREE.Mesh(ringGeo, padMat.clone());
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(px, 0.04, pz);
          this.scene.add(ring);
        } else if (tile === 5) {
          // Exit portal — bright emissive, no extra point light (light budget kept tight)
          const exitGeo = new THREE.TorusGeometry(1.5, 0.2, 8, 24);
          const exitMat = new THREE.MeshBasicMaterial({
            color: this.theme.accent2,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const exit = new THREE.Mesh(exitGeo, exitMat);
          exit.position.set(px, 1.5, pz);
          exit.rotation.y = Math.PI / 4;
          exit.name = 'exit_portal';
          this.scene.add(exit);
        }
      }
    }

    // Merge collected walls into a single mesh — drastically reduces draw calls
    if (wallGeos.length > 0) {
      const wallMat = new THREE.MeshStandardMaterial({
        color: this.theme.bgPanel,
        metalness: 0.8,
        roughness: 0.2,
      });
      const merged = mergeGeometries(wallGeos, false);
      if (merged) this.scene.add(new THREE.Mesh(merged, wallMat));
      wallGeos.forEach(g => g.dispose());
    }
    if (stripGeos.length > 0) {
      const stripMat = new THREE.MeshBasicMaterial({ color: this.theme.primary });
      const merged = mergeGeometries(stripGeos, false);
      if (merged) this.scene.add(new THREE.Mesh(merged, stripMat));
      stripGeos.forEach(g => g.dispose());
    }
    wallTemplate.dispose();
    stripTemplate.dispose();

    // Heart Defense — central object the player must protect
    if (this.mode === 'heart_defense') {
      const heartGroup = new THREE.Group();
      const cx = Math.floor(this.maze.width / 2);
      const cy = Math.floor(this.maze.height / 2);
      const px = (cx - this.maze.width / 2) * TILE_SIZE;
      const pz = (cy - this.maze.height / 2) * TILE_SIZE;
      // Ensure the heart cell is walkable
      this.maze.grid[cy][cx] = 0;

      const coreGeo = new THREE.IcosahedronGeometry(0.8, 1);
      const coreMat = new THREE.MeshStandardMaterial({
        color: this.theme.accent1,
        emissive: this.theme.accent1,
        emissiveIntensity: 1.5,
        metalness: 0.6,
        roughness: 0.2,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.name = 'heart_core';
      heartGroup.add(core);

      const haloGeo = new THREE.SphereGeometry(1.4, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color: this.theme.accent1,
        transparent: true,
        opacity: 0.15,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      heartGroup.add(halo);

      // Floor pad to mark the spot
      const padGeo = new THREE.CircleGeometry(2.0, 32);
      const padMat = new THREE.MeshBasicMaterial({
        color: this.theme.accent1,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.y = -0.65;
      heartGroup.add(pad);

      heartGroup.position.set(px, 1.0, pz);
      this.scene.add(heartGroup);
      this.heart.mesh = heartGroup;
      this.heart.position.set(px, 1.0, pz);

      // Pulse animation
      this.onUpdateRoutines.push((t) => {
        const hpPct = this.heart.hp / this.heart.maxHp;
        const lowHp = hpPct < 0.35;
        const speed = lowHp ? 6 : 2;
        const intensity = lowHp ? 2 : 1.2;
        const pulse = 1 + Math.sin(t * speed) * 0.05;
        heartGroup.scale.set(pulse, pulse, pulse);
        coreMat.emissiveIntensity = intensity + Math.sin(t * speed) * 0.5;
        if (lowHp) coreMat.emissive.set(this.theme.red);
        else coreMat.emissive.set(this.theme.accent1);
      });
    }

    // Single batched routine for all tower spot rings (instead of one per spot)
    if (ringAnimRefs.length > 0) {
      this.onUpdateRoutines.push((t) => {
        const sin4 = Math.sin(t * 4);
        const sin2 = Math.sin(t * 2);
        const yBob = 0.6 + sin2 * 0.15;
        const emiss = 0.4 + sin4 * 0.2;
        for (const r of ringAnimRefs) {
          r.ring.rotation.z = t;
          r.ring.position.y = yBob;
          r.spot.material.emissiveIntensity = emiss;
        }
      });
    }

    // Door indicators: spin + bob; hide once the corresponding door is open
    if (doorIndicatorRefs.length > 0) {
      this.onUpdateRoutines.push((t) => {
        const yBob = WALL_HEIGHT + 0.7 + Math.sin(t * 3) * 0.15;
        for (const r of doorIndicatorRefs) {
          const [dx, dy] = r.doorKey.split(',').map(Number);
          const door = this.maze.doors.find(d => d.x === dx && d.y === dy);
          if (door?.open) {
            r.mesh.visible = false;
          } else {
            r.mesh.position.y = yBob;
            r.mesh.rotation.x = t * 1.5;
            r.mesh.rotation.y = t * 2;
          }
        }
      });
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    this.keys[key] = true;

    if (key === 'c') {
      this.cycleCameraMode();
    }

    // Space to fire (with auto-aim)
    if (key === ' ') {
      this.firePlayerShot();
      e.preventDefault();
    }
    // E to interact (currently: build a tower when standing on a free spot)
    if (key === 'e') {
      this.requestBuildTower();
    }

    if (e.key === 'ArrowUp') this.keys['z'] = true;
    if (e.key === 'ArrowDown') this.keys['s'] = true;
    if (e.key === 'ArrowLeft') this.keys['q'] = true;
    if (e.key === 'ArrowRight') this.keys['d'] = true;
  }

  private onKeyUp(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    this.keys[key] = false;
    if (e.key === 'ArrowUp') this.keys['z'] = false;
    if (e.key === 'ArrowDown') this.keys['s'] = false;
    if (e.key === 'ArrowLeft') this.keys['q'] = false;
    if (e.key === 'ArrowRight') this.keys['d'] = false;
  }

  private boundClick = (e: MouseEvent) => {
    // Left click = fire
    if (e.button === 0) this.firePlayerShot();
  };

  private setupControls() {
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    this.renderer.domElement.addEventListener('click', this.boundClick);
  }

  /** Auto-aim shot at the closest enemy within range. Falls back to forward direction. */
  public firePlayerShot() {
    const now = this.clock.elapsedTime;
    if (now - this.playerLastFire < ThreeEngine.PLAYER_FIRE_COOLDOWN) return;
    if (this.player.ammo <= 0) {
      // Empty-chamber feedback (sharp short tone) and small shake hint
      AudioEngine.playWrong();
      this.shakeIntensity = 0.15;
      return;
    }
    this.playerLastFire = now;
    this.player.ammo--;

    // Find closest enemy in range
    let closest: typeof this.enemies[number] | null = null;
    let closestDist = ThreeEngine.PLAYER_FIRE_RANGE;
    for (const e of this.enemies) {
      const d = e.mesh.position.distanceTo(this.playerObj.position);
      if (d < closestDist) {
        closest = e;
        closestDist = d;
      }
    }

    const start = this.playerObj.position.clone().add(new THREE.Vector3(0, 0.4, 0));
    if (closest) {
      this.spawnProjectile(start, closest, 0x00f5d4);
    } else {
      const dir = new THREE.Vector3(Math.sin(this.playerObj.rotation.y), 0, Math.cos(this.playerObj.rotation.y));
      this.spawnForwardProjectile(start, dir, 0x00f5d4);
    }
    AudioEngine.playClick();
  }

  /** Public: top up ammunition (after a correct QCM answer). */
  public refillAmmo(amount = ThreeEngine.AMMO_PER_CORRECT) {
    this.player.ammo = Math.min(ThreeEngine.MAX_AMMO, this.player.ammo + amount);
  }

  private spawnForwardProjectile(startPos: THREE.Vector3, dir: THREE.Vector3, color: number) {
    const geo = new THREE.SphereGeometry(0.2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(startPos);

    const trailPoints = [startPos.clone(), startPos.clone()];
    const trailGeo = new THREE.BufferGeometry().setFromPoints(trailPoints);
    const trailMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
    const trail = new THREE.Line(trailGeo, trailMat);

    this.scene.add(mesh);
    this.scene.add(trail);

    this.projectiles.push({ mesh, trail, velocity: dir.clone().multiplyScalar(25), target: null, ttl: 1.2 });
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private enemies: { mesh: THREE.Mesh, speed: number, path: [number, number][], lastPathCalc: number, type: EnemyType, hp: number, maxHp: number, hitFlashUntil: number, hitMaterial: THREE.MeshStandardMaterial | null }[] = [];
  private waveTimer = 0;

  private spawnEnemy(speedOverride?: number, typeOverride?: EnemyType) {
    const spawn = this.maze.spawns[Math.floor(Math.random() * this.maze.spawns.length)];
    const px = (spawn.x - this.maze.width / 2) * TILE_SIZE;
    const pz = (spawn.y - this.maze.height / 2) * TILE_SIZE;

    // Determine type — explicit override > wave roll > level roll
    const type: EnemyType = typeOverride
      ?? (this.isWaveMode
        ? rollEnemyTypeForWave(this.waveNumber, 0, this.enemiesRemainingThisWave + 1)
        : rollEnemyTypeForLevel(this.level));
    const cfg = ENEMY_CONFIGS[type];
    const tint = this.theme[cfg.themeColorKey] as string;

    const group = new THREE.Group();
    let coreGeo: THREE.BufferGeometry;
    if (type === 'swift')      coreGeo = new THREE.DodecahedronGeometry(0.35, 0);
    else if (type === 'brute') coreGeo = new THREE.OctahedronGeometry(0.65, 0);
    else if (type === 'boss')  coreGeo = new THREE.IcosahedronGeometry(0.95, 1);
    else                       coreGeo = new THREE.IcosahedronGeometry(0.5, 0);

    const coreMat = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: type === 'boss' ? 1.4 : 1,
      wireframe: type !== 'brute', // BRUTE is solid for a "heavy armor" feel
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    // Outer translucent shell — wider on tanks and boss
    const shellRadius = 0.6 * cfg.scaleMultiplier;
    const shellGeo = new THREE.SphereGeometry(shellRadius, 8, 8);
    const shellMat = new THREE.MeshBasicMaterial({
      color: tint, transparent: true, opacity: type === 'boss' ? 0.18 : 0.1, wireframe: true,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    group.add(shell);

    // Boss gets a halo ring at the base for unmistakable identification
    if (type === 'boss') {
      const ringGeo = new THREE.TorusGeometry(1.0, 0.07, 8, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: tint, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.3;
      group.add(ring);
    }

    group.position.set(px, 0.5, pz);

    const light = new THREE.PointLight(tint, type === 'boss' ? 5 : 3, type === 'boss' ? 9 : 6);
    group.add(light);

    this.scene.add(group);

    const baseSpeed = speedOverride ?? this.enemyBaseSpeed;
    this.enemies.push({
      mesh: group as any,
      speed: baseSpeed * cfg.speedMultiplier + Math.random() * 0.5,
      path: [],
      lastPathCalc: 0,
      type,
      hp: cfg.hp,
      maxHp: cfg.hp,
      hitFlashUntil: 0,
      hitMaterial: coreMat,
    });
    AudioEngine.playSpawn();
  }

  /**
   * Damage an enemy by `amount` HP. Removes it and credits score on kill.
   * Briefly flashes its material on hit so the player gets feedback.
   */
  private damageEnemy(enemy: typeof this.enemies[number], amount: number) {
    enemy.hp -= amount;
    enemy.hitFlashUntil = this.clock.elapsedTime + 0.12;
    if (enemy.hp <= 0) {
      const idx = this.enemies.indexOf(enemy);
      if (idx !== -1) {
        const cfg = ENEMY_CONFIGS[enemy.type];
        const deathPos = enemy.mesh.position.clone();
        this.scene.remove(enemy.mesh);
        this.enemies.splice(idx, 1);
        this.player.score += cfg.scoreValue;
        this.enemiesKilled++;
        // Juicy feedback: floating "+X" sprite + hit-stop on big kills
        this.spawnFloatText(`+${cfg.scoreValue}`, deathPos, this.theme[cfg.themeColorKey] as string);
        if (enemy.type === 'boss') this.triggerHitStop(0.18);
        else if (enemy.type === 'brute') this.triggerHitStop(0.06);
      }
    }
  }

  /** Pause simulation for `duration` seconds for dramatic effect. */
  public triggerHitStop(duration: number) {
    this.hitStopUntil = Math.max(this.hitStopUntil, this.clock.elapsedTime + duration);
  }

  /** Spawn a floating text sprite at world position. */
  private spawnFloatText(text: string, position: THREE.Vector3, color: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.font = 'bold 44px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillText(text, 128, 36);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.position.y += 1.4;
    sprite.scale.set(3, 0.75, 1);
    sprite.renderOrder = 999; // always on top
    this.scene.add(sprite);
    this.floatTexts.push({ sprite, ttl: 1.1, lifeTotal: 1.1 });
  }

  /** Animate float texts (drift up, fade) and prune dead ones. */
  private tickFloatTexts(dt: number) {
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const ft = this.floatTexts[i];
      ft.ttl -= dt;
      ft.sprite.position.y += dt * 2.0;
      const alpha = Math.max(0, ft.ttl / ft.lifeTotal);
      (ft.sprite.material as THREE.SpriteMaterial).opacity = alpha;
      if (ft.ttl <= 0) {
        this.scene.remove(ft.sprite);
        const m = ft.sprite.material as THREE.SpriteMaterial;
        m.map?.dispose();
        m.dispose();
        this.floatTexts.splice(i, 1);
      }
    }
  }

  private updateWaves(dt: number) {
    if (this.waveActive) {
      this.waveSpawnTimer += dt;
      if (this.enemiesRemainingThisWave > 0 && this.waveSpawnTimer >= this.waveSpawnInterval) {
        const indexInWave = this.currentWaveSize - this.enemiesRemainingThisWave;
        const type = rollEnemyTypeForWave(this.waveNumber, indexInWave, this.currentWaveSize);
        this.spawnEnemy(this.waveCurrentSpeed, type);
        this.enemiesRemainingThisWave--;
        this.waveSpawnTimer = 0;
      }
      // Wave ends when no more spawns AND no live enemies remain
      if (this.enemiesRemainingThisWave === 0 && this.enemies.length === 0) {
        this.endWave();
      }
    } else {
      this.waveLullTimer += dt;
      if (this.waveLullTimer >= this.waveLullDuration) {
        this.startNextWave();
      }
    }
  }

  private startNextWave() {
    this.waveNumber++;
    const cfg = waveConfigForWave(this.waveNumber);
    this.enemiesRemainingThisWave = cfg.size;
    this.currentWaveSize = cfg.size;
    this.waveSpawnInterval = cfg.spawnInterval;
    this.waveCurrentSpeed = cfg.enemySpeed;
    this.waveActive = true;
    this.waveSpawnTimer = this.waveSpawnInterval; // spawn first enemy immediately
    this.onWaveStart?.(this.waveNumber);
  }

  private endWave() {
    this.waveActive = false;
    this.waveLullTimer = 0;
    this.waveLullDuration = 4.0; // standard lull after wave 1

    // Rewards: ammo + score (always), heart regen (Heart Defense only)
    const cfg = waveConfigForWave(this.waveNumber);
    const scoreBonus = 200 + (cfg.isBoss ? 500 : 0);
    const ammoBonus = cfg.isBoss ? 5 : 3;
    this.player.score += scoreBonus;
    this.player.ammo = Math.min(ThreeEngine.MAX_AMMO, this.player.ammo + ammoBonus);
    if (this.mode === 'heart_defense') {
      this.heart.hp = Math.min(this.heart.maxHp, this.heart.hp + (cfg.isBoss ? 2 : 1));
    }
    // Drop pickups as wave-end reward — 1 standard / 3 on boss waves
    const pickupCount = cfg.isBoss ? 3 : 1;
    for (let i = 0; i < pickupCount; i++) this.spawnPickup();
    this.onWaveEnd?.(this.waveNumber);
  }

  /** Pick a walkable cell that is reasonably far from the player and other pickups. */
  private spawnPickup() {
    if (this.pickups.length >= ThreeEngine.MAX_PICKUPS) return;

    const candidates: { x: number; y: number }[] = [];
    for (let y = 1; y < this.maze.height - 1; y++) {
      for (let x = 1; x < this.maze.width - 1; x++) {
        if (this.maze.grid[y][x] !== 0) continue; // only on plain floor
        const wx = (x - this.maze.width / 2) * TILE_SIZE;
        const wz = (y - this.maze.height / 2) * TILE_SIZE;
        const distPlayer = Math.hypot(wx - this.playerObj.position.x, wz - this.playerObj.position.z);
        if (distPlayer < 6) continue;
        const conflict = this.pickups.some(p => Math.abs(p.gridX - x) + Math.abs(p.gridY - y) < 4);
        if (conflict) continue;
        // In heart_defense, avoid spawning too close to the heart itself (otherwise pickups look like part of it)
        if (this.mode === 'heart_defense') {
          const dh = Math.hypot(wx - this.heart.position.x, wz - this.heart.position.z);
          if (dh < 4) continue;
        }
        candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) return;
    const cell = candidates[Math.floor(Math.random() * candidates.length)];
    const type = rollPickupType();
    const cfg = PICKUP_CONFIGS[type];
    const color = this.theme[cfg.themeColorKey] as string;

    const group = new THREE.Group();

    // Main shape varies by type for clear visual identity
    let coreGeo: THREE.BufferGeometry;
    if (type === 'ammo') coreGeo = new THREE.OctahedronGeometry(0.42, 0);
    else if (type === 'heal') coreGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    else coreGeo = new THREE.TorusGeometry(0.36, 0.13, 8, 20);

    const coreMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.4,
      metalness: 0.5,
      roughness: 0.3,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    // Floor halo to draw the eye from far away
    const haloGeo = new THREE.CircleGeometry(0.9, 24);
    const haloMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.6;
    group.add(halo);

    const wx = (cell.x - this.maze.width / 2) * TILE_SIZE;
    const wz = (cell.y - this.maze.height / 2) * TILE_SIZE;
    group.position.set(wx, 0.8, wz);
    this.scene.add(group);

    this.pickups.push({
      group, type,
      gridX: cell.x, gridY: cell.y,
      spawnedAt: this.clock.elapsedTime,
    });
  }

  private updatePickups(dt: number, time: number) {
    // Drip schedule: every 12s during the run, attempt to spawn a new pickup
    if (this.pickups.length < ThreeEngine.MAX_PICKUPS) {
      this.pickupDripTimer += dt;
      if (this.pickupDripTimer >= ThreeEngine.PICKUP_DRIP_INTERVAL) {
        this.spawnPickup();
        this.pickupDripTimer = 0;
      }
    }

    // Animate + check for collection
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.group.rotation.y += dt * 1.6;
      p.group.position.y = 0.8 + Math.sin(time * 2 + i) * 0.15;

      const d = Math.hypot(
        p.group.position.x - this.playerObj.position.x,
        p.group.position.z - this.playerObj.position.z
      );
      if (d < 1.0) {
        this.collectPickup(p);
        this.scene.remove(p.group);
        this.pickups.splice(i, 1);
      }
    }
  }

  private collectPickup(p: { type: PickupType }) {
    const cfg = PICKUP_CONFIGS[p.type];
    this.lastPickupCollected = { type: p.type, label: cfg.label, at: this.clock.elapsedTime };
    if (p.type === 'ammo') {
      this.player.ammo = Math.min(ThreeEngine.MAX_AMMO, this.player.ammo + cfg.effectValue);
    } else if (p.type === 'heal') {
      this.player.hp = Math.min(3, this.player.hp + cfg.effectValue);
    } else if (p.type === 'score') {
      this.player.score += cfg.effectValue;
    }
    AudioEngine.playCorrect();
  }

  private onUpdateRoutines: ((t: number) => void)[] = [];
  private velocity = new THREE.Vector3();
  shakeIntensity = 0; // public so React can trigger one last shake on death

  private projectiles: { mesh: THREE.Mesh, trail: THREE.Line, velocity: THREE.Vector3, target: any, ttl?: number }[] = [];
  private towers: { mesh: THREE.Mesh, lastFire: number, range: number }[] = [];

  private spawnProjectile(startPos: THREE.Vector3, target: any, color?: number) {
    const c = color ?? new THREE.Color(this.theme.accent2).getHex();
    const geo = new THREE.SphereGeometry(0.2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: c });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(startPos);

    // Trail
    const trailPoints = [startPos.clone(), startPos.clone()];
    const trailGeo = new THREE.BufferGeometry().setFromPoints(trailPoints);
    const trailMat = new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending });
    const trail = new THREE.Line(trailGeo, trailMat);
    
    this.scene.add(mesh);
    this.scene.add(trail);
    
    const dir = target.mesh.position.clone().sub(startPos).normalize();
    this.projectiles.push({ mesh, trail, velocity: dir.multiplyScalar(25), target });
  }

  private createImpact(pos: THREE.Vector3) {
      const geo = new THREE.SphereGeometry(0.1, 8, 8);
      const mat = new THREE.MeshBasicMaterial({ color: this.theme.accent2, transparent: true, opacity: 1 });
      const burst = new THREE.Mesh(geo, mat);
      burst.position.copy(pos);
      this.scene.add(burst);
      
      let scale = 1;
      const animate = () => {
          scale += 0.5;
          burst.scale.set(scale, scale, scale);
          mat.opacity *= 0.8;
          if (mat.opacity > 0.05) requestAnimationFrame(animate);
          else this.scene.remove(burst);
      };
      animate();
  }

  /** Open a door with visible feedback. Called by the React layer after a correct answer. */
  public openDoor(door: { x: number; y: number; open: boolean }) {
    door.open = true;
    // No cooldown bookkeeping anymore — the door is now walkable, so checkTriggers won't
    // re-target it (the `door.open` check short-circuits the proximity scan).
    const doorObj = this.scene.getObjectByName(`door_${door.x}_${door.y}`) as THREE.Mesh | undefined;
    if (!doorObj) return;

    const mat = doorObj.material as THREE.MeshStandardMaterial;
    // Flash to green to signal success, then slide the panel down
    const originalColor = mat.color.getHex();
    const originalEmissive = mat.emissive.getHex();
    mat.color.set(this.theme.green);
    mat.emissive.set(this.theme.green);
    mat.emissiveIntensity = 1.5;

    const startY = doorObj.position.y;
    const targetY = -WALL_HEIGHT;
    let progress = 0;
    const animate = () => {
      if (!this.running) return;
      progress += 0.04;
      const p = Math.min(1, progress);
      doorObj.position.y = startY + (targetY - startY) * p;
      mat.opacity = 0.8 * (1 - p);
      if (p < 1) requestAnimationFrame(animate);
      else {
        // Restore in case the engine is restarted with cached objects
        mat.color.setHex(originalColor);
        mat.emissive.setHex(originalEmissive);
      }
    };
    animate();
    AudioEngine.playDoorOpen();
  }

  /** Heart Defense — spawn an army unit that orbits the heart and hunts enemies. */
  public spawnArmyUnit() {
    if (this.units.length >= 20) return; // cap army size
    const baseAngle = (this.unitsBuilt * 0.7) % (Math.PI * 2); // spread units evenly
    const geo = new THREE.SphereGeometry(0.35, 12, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: this.theme.primaryLight,
      emissive: this.theme.primary,
      emissiveIntensity: 1.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const radius = 2.8;
    mesh.position.set(
      this.heart.position.x + Math.cos(baseAngle) * radius,
      this.heart.position.y,
      this.heart.position.z + Math.sin(baseAngle) * radius,
    );
    this.scene.add(mesh);
    this.units.push({ mesh, angle: baseAngle, speed: 0.6, lastFire: 0, hp: 2, huntTarget: null });
    this.unitsBuilt++;
    AudioEngine.playSpawn();
  }

  public addTower(spot: { x: number, y: number }) {
    // Check if already occupied
    const mazeSpot = this.maze.towerSpots.find(s => s.x === spot.x && s.y === spot.y);
    if (mazeSpot?.occupied) return;
    if (mazeSpot) mazeSpot.occupied = true;

    const px = (spot.x - this.maze.width / 2) * TILE_SIZE;
    const pz = (spot.y - this.maze.height / 2) * TILE_SIZE;

    // Tower Base
    const baseGeo = new THREE.CylinderGeometry(0.8, 1.2, 1.5, 6);
    const baseMat = new THREE.MeshStandardMaterial({ color: this.theme.primary, metalness: 0.9, roughness: 0.1 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(px, 0.75, pz);
    base.castShadow = true;
    this.scene.add(base);

    // Tower Top (Head)
    const headGeo = new THREE.IcosahedronGeometry(0.6, 1);
    const headMat = new THREE.MeshStandardMaterial({ 
        color: this.theme.primaryLight, 
        emissive: this.theme.primary, 
        emissiveIntensity: 0.8 
    });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(px, 2.2, pz);
    head.castShadow = true;
    this.scene.add(head);

    this.towers.push({ mesh: head, lastFire: 0, range: 18 });

    // Skip per-tower PointLight: emissive material is enough and avoids shader recompiles
    // when adding multiple towers (each new light triggers re-compile of all StandardMaterials)

    AudioEngine.playCorrect();
    this.createImpact(new THREE.Vector3(px, 1.5, pz));
  }

  update() {
    const dt = this.clock.getDelta();
    const time = this.clock.elapsedTime;
    if (this.paused) {
      // Keep rendering but freeze every simulation step.
      return;
    }
    // Hit-stop — pause simulation for a few frames after a big event for impact
    if (time < this.hitStopUntil) {
      // Still tick float text animations so the player sees the +score float during the freeze
      this.tickFloatTexts(dt);
      return;
    }
    this.player.timer -= dt;

    // Towers firing logic — fast cadence, auto-target nearest enemy in range
    for (const t of this.towers) {
      if (time - t.lastFire > 0.5) {
        let target: typeof this.enemies[number] | null = null;
        let bestDist = t.range;
        for (const e of this.enemies) {
          const d = e.mesh.position.distanceTo(t.mesh.position);
          if (d < bestDist) { target = e; bestDist = d; }
        }
        if (target) {
          this.spawnProjectile(t.mesh.position.clone().add(new THREE.Vector3(0, 1, 0)), target);
          t.lastFire = time;
          AudioEngine.playClick();
        }
      }
    }

    // Projectile movement and impact
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const lastPos = p.mesh.position.clone();
      p.mesh.position.add(p.velocity.clone().multiplyScalar(dt));

      const positions = p.trail.geometry.attributes.position.array as Float32Array;
      positions[0] = p.mesh.position.x;
      positions[1] = p.mesh.position.y;
      positions[2] = p.mesh.position.z;
      positions[3] = THREE.MathUtils.lerp(positions[3], lastPos.x, 0.5);
      positions[4] = THREE.MathUtils.lerp(positions[4], lastPos.y, 0.5);
      positions[5] = THREE.MathUtils.lerp(positions[5], lastPos.z, 0.5);
      p.trail.geometry.attributes.position.needsUpdate = true;

      // Forward (no-target) projectiles: TTL + scan for hits any frame
      if (p.target === null) {
        p.ttl = (p.ttl ?? 1.2) - dt;
        let hit: typeof this.enemies[number] | null = null;
        for (const e of this.enemies) {
          if (e.mesh.position.distanceTo(p.mesh.position) < 1.0) { hit = e; break; }
        }
        if (hit) {
          this.createImpact(p.mesh.position);
          this.scene.remove(p.mesh); this.scene.remove(p.trail);
          this.projectiles.splice(i, 1);
          this.damageEnemy(hit, 1);
          continue;
        }
        if ((p.ttl ?? 0) <= 0 || p.mesh.position.length() > 500) {
          this.scene.remove(p.mesh); this.scene.remove(p.trail);
          this.projectiles.splice(i, 1);
        }
        continue;
      }

      // Targeted projectile: home in
      if (p.mesh.position.distanceTo(p.target.mesh.position) < 1) {
        this.createImpact(p.mesh.position);
        this.scene.remove(p.mesh); this.scene.remove(p.trail);
        this.projectiles.splice(i, 1);
        this.damageEnemy(p.target, 1);
      } else if (p.mesh.position.length() > 500) {
        this.scene.remove(p.mesh); this.scene.remove(p.trail);
        this.projectiles.splice(i, 1);
      }
    }

    // Run custom update routines
    this.onUpdateRoutines.forEach(fn => fn(time));

    // Animate floating "+score" texts
    this.tickFloatTexts(dt);

    // Enemy production: either continuous (Survival) or wave-based (TD / HD)
    if (this.isWaveMode) {
      this.updateWaves(dt);
      // Pickups only make sense in wave modes — encourages exploration during lulls
      this.updatePickups(dt, time);
    } else if (Number.isFinite(this.waveInterval)) {
      this.waveTimer += dt;
      if (this.waveTimer > this.waveInterval) {
        this.spawnEnemy();
        this.waveTimer = 0;
      }
    }

    // Move enemies using pathfinding
    const playerGridX = Math.round((this.playerObj.position.x / TILE_SIZE) + this.maze.width / 2);
    const playerGridZ = Math.round((this.playerObj.position.z / TILE_SIZE) + this.maze.height / 2);

    // In Heart Defense the enemies path to the HEART instead of the player
    const heartGridX = this.mode === 'heart_defense' ? Math.floor(this.maze.width / 2) : playerGridX;
    const heartGridZ = this.mode === 'heart_defense' ? Math.floor(this.maze.height / 2) : playerGridZ;
    const targetGridX = this.mode === 'heart_defense' ? heartGridX : playerGridX;
    const targetGridZ = this.mode === 'heart_defense' ? heartGridZ : playerGridZ;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];

        // Recalculate path every 500ms to save CPU
        if (time - e.lastPathCalc > 0.5) {
            const eGridX = Math.round((e.mesh.position.x / TILE_SIZE) + this.maze.width / 2);
            const eGridZ = Math.round((e.mesh.position.z / TILE_SIZE) + this.maze.height / 2);
            e.path = this.maze.getPath(eGridX, eGridZ, targetGridX, targetGridZ);
            e.lastPathCalc = time;
        }

        if (e.path.length > 0) {
            const targetNode = e.path[0];
            const targetPX = (targetNode[0] - this.maze.width / 2) * TILE_SIZE;
            const targetPZ = (targetNode[1] - this.maze.height / 2) * TILE_SIZE;

            const targetPos = new THREE.Vector3(targetPX, 0.5, targetPZ);
            const dir = targetPos.clone().sub(e.mesh.position).normalize();
            const step = dir.multiplyScalar(e.speed * dt);

            // Move only if the destination cell is walkable for the enemy too
            const next = e.mesh.position.clone().add(step);
            if (!this.collideAt(next, 0.35)) {
              e.mesh.position.copy(next);
            } else {
              // Wall in the way — try axis-separated motion (lets enemies hug corners)
              const stepX = new THREE.Vector3(step.x, 0, 0);
              const stepZ = new THREE.Vector3(0, 0, step.z);
              const tryX = e.mesh.position.clone().add(stepX);
              if (!this.collideAt(tryX, 0.35)) e.mesh.position.copy(tryX);
              const tryZ = e.mesh.position.clone().add(stepZ);
              if (!this.collideAt(tryZ, 0.35)) e.mesh.position.copy(tryZ);
              // Force a path recompute next frame
              e.lastPathCalc = 0;
            }

            if (e.mesh.position.distanceTo(new THREE.Vector3(targetPX, 0.5, targetPZ)) < 0.5) {
                e.path.shift();
            }
        }
        // No fallback "straight line through walls" — if path is empty, the enemy
        // stays put until the next path recompute (every 500ms).

        e.mesh.rotation.y += dt * 5;
        e.mesh.position.y = 0.5 + Math.sin(time * 5 + i) * 0.2;

        // Hit-flash: brighten the core material right after a damage event
        if (e.hitMaterial) {
          if (time < e.hitFlashUntil) {
            e.hitMaterial.emissiveIntensity = 3.5;
          } else {
            const target = e.type === 'boss' ? 1.4 : 1.0;
            e.hitMaterial.emissiveIntensity = THREE.MathUtils.lerp(e.hitMaterial.emissiveIntensity, target, 0.2);
          }
        }

        // Dynamic glow on the embedded point light
        e.mesh.traverse(c => {
            if (c instanceof THREE.PointLight) {
                c.intensity = 2 + Math.sin(time * 12) * 1.5;
            }
        });

        // Collision logic depends on mode
        if (this.mode === 'heart_defense') {
          // Heart contact takes priority — enemies that reach the heart damage it
          if (e.mesh.position.distanceTo(this.heart.position) < 1.5) {
            this.heart.hp = Math.max(0, this.heart.hp - 1);
            this.shakeIntensity = 0.4;
            this.scene.remove(e.mesh);
            this.enemies.splice(i, 1);
            AudioEngine.playWrong();
            continue;
          }
          // Unit collision — units soak hits before the player does
          let killedByUnit = false;
          for (let u = this.units.length - 1; u >= 0; u--) {
            const unit = this.units[u];
            if (e.mesh.position.distanceTo(unit.mesh.position) < 0.7) {
              unit.hp -= 1;
              if (unit.hp <= 0) {
                this.scene.remove(unit.mesh);
                this.units.splice(u, 1);
              }
              this.scene.remove(e.mesh);
              this.enemies.splice(i, 1);
              killedByUnit = true;
              break;
            }
          }
          if (killedByUnit) continue;
        }
        // Sprint: enemies don't spawn (waveInterval=Infinity), but be defensive: no HP loss either
        if (this.mode === 'sprint') continue;
        // Survival / TD: player contact = -1 HP
        if (e.mesh.position.distanceTo(this.playerObj.position) < 1.2) {
            this.player.hp -= 1;
            this.shakeIntensity = 0.5;
            this.scene.remove(e.mesh);
            this.enemies.splice(i, 1);
            AudioEngine.playWrong();
        }
    }

    // Heart Defense — units have two modes: ORBIT (no enemy in range) and HUNT (chase & fire)
    if (this.mode === 'heart_defense' && this.units.length > 0) {
      const orbitRadius = 2.8;
      const detectionRange = 10;     // units start hunting when an enemy enters this radius
      const fireRange = 7;           // they fire when within this radius
      const huntSpeed = 4.5;
      const orbitSpeed = 0.6;
      const fireCooldown = 0.75;
      const maxLeashFromHeart = 7;   // units never chase further than this from the heart

      for (const unit of this.units) {
        // (Re)acquire a target — closest enemy within detection range
        let target: typeof this.enemies[number] | null = null;
        let bestDist = detectionRange;
        for (const en of this.enemies) {
          const d = en.mesh.position.distanceTo(unit.mesh.position);
          if (d < bestDist) { target = en; bestDist = d; }
        }
        unit.huntTarget = target;

        // Also bail out of hunt if the target wandered too far from the heart (don't desert)
        if (target) {
          const fromHeart = target.mesh.position.distanceTo(this.heart.position);
          if (fromHeart > maxLeashFromHeart + 2) target = null;
        }

        if (target) {
          // HUNT — move toward the target, fire when in fire range
          const dir = target.mesh.position.clone().sub(unit.mesh.position).normalize();
          const step = dir.multiplyScalar(huntSpeed * dt);
          unit.mesh.position.add(step);

          // Don't overshoot the leash from heart
          const fromHeart = unit.mesh.position.distanceTo(this.heart.position);
          if (fromHeart > maxLeashFromHeart) {
            const back = this.heart.position.clone().sub(unit.mesh.position).normalize();
            unit.mesh.position.add(back.multiplyScalar(fromHeart - maxLeashFromHeart));
          }

          // Re-sync the orbit angle so the unit doesn't snap when returning
          unit.angle = Math.atan2(unit.mesh.position.z - this.heart.position.z, unit.mesh.position.x - this.heart.position.x);

          if (bestDist < fireRange && time - unit.lastFire > fireCooldown) {
            this.spawnProjectile(unit.mesh.position.clone().add(new THREE.Vector3(0, 0.1, 0)), target);
            unit.lastFire = time;
          }
        } else {
          // ORBIT — patrol around the heart
          unit.angle += orbitSpeed * dt;
          const orbitX = this.heart.position.x + Math.cos(unit.angle) * orbitRadius;
          const orbitZ = this.heart.position.z + Math.sin(unit.angle) * orbitRadius;
          unit.mesh.position.x = THREE.MathUtils.lerp(unit.mesh.position.x, orbitX, 0.1);
          unit.mesh.position.z = THREE.MathUtils.lerp(unit.mesh.position.z, orbitZ, 0.1);
        }

        // Subtle bob
        unit.mesh.position.y = 0.7 + Math.sin(time * 4 + unit.angle) * 0.1;
      }
    }

    // Player Movement with Friction & Acceleration
    const accel = 70 * dt;
    const friction = 0.2;

    // Freeze input acquisition while a quiz is active so the player can't keep accelerating
    // toward the next door and chain-trigger immediately after confirming.
    if (!this.quizLocked) {
      if (this.keys['z'] || this.keys['w'] || this.keys['arrowup']) this.velocity.z -= accel;
      if (this.keys['s'] || this.keys['arrowdown']) this.velocity.z += accel;
      if (this.keys['q'] || this.keys['a'] || this.keys['arrowleft']) this.velocity.x -= accel;
      if (this.keys['d'] || this.keys['arrowright']) this.velocity.x += accel;

      if (this.touchVector.x !== 0 || this.touchVector.z !== 0) {
        this.velocity.x += this.touchVector.x * accel;
        this.velocity.z += this.touchVector.z * accel;
      }
    }

    this.velocity.multiplyScalar(1 - friction);
    if (this.velocity.length() < 0.01) this.velocity.set(0, 0, 0);

    // Axis-separated collision so the player slides along walls instead of stopping cold
    const radius = ThreeEngine.PLAYER_RADIUS;
    const tryX = this.playerObj.position.clone();
    tryX.x += this.velocity.x * dt;
    if (!this.collideAt(tryX, radius)) {
      this.playerObj.position.x = tryX.x;
    } else {
      this.velocity.x = 0;
    }
    const tryZ = this.playerObj.position.clone();
    tryZ.z += this.velocity.z * dt;
    if (!this.collideAt(tryZ, radius)) {
      this.playerObj.position.z = tryZ.z;
    } else {
      this.velocity.z = 0;
    }

    // Trigger detection runs once per frame at the final position
    this.checkTriggers(this.playerObj.position);

    // Camera modes — each is self-contained and stable
    this.shakeIntensity *= 0.9;
    const shake = new THREE.Vector3(
      (Math.random() - 0.5) * this.shakeIntensity,
      (Math.random() - 0.5) * this.shakeIntensity,
      (Math.random() - 0.5) * this.shakeIntensity
    );
    const playerPos = this.playerObj.position;

    // Fog management: tactical disables fog entirely (otherwise the high altitude makes
    // the scene fade to black via FogExp2). Bird uses a lighter version.
    if (this.cameraMode === 'tactical') {
      this.scene.fog = null;
    } else if (this.cameraMode === 'bird') {
      // Halve the density for the corner-isometric view to keep distant cells readable
      this.scene.fog = new THREE.FogExp2(this.theme.bgDark, this.baseFog.density * 0.4);
    } else {
      this.scene.fog = this.baseFog;
    }

    if (this.cameraMode === 'follow') {
      // Third-person TPS — camera fixed in WORLD frame behind the player.
      // We don't rotate with the player's facing because WASD is world-relative:
      // rotating the camera would invert controls and disorient. Lower altitude,
      // closer behind = "over-the-shoulder" feel without the orientation conflict.
      const target = playerPos.clone().add(new THREE.Vector3(0, 7, 11)).add(shake);
      this.camera.up.set(0, 1, 0);
      this.camera.position.lerp(target, 0.18);
      // Look slightly above the player's feet for nicer composition
      this.camera.lookAt(playerPos.x, playerPos.y + 0.5, playerPos.z);
    } else if (this.cameraMode === 'top') {
      // Top-down with a slight forward tilt for depth perception — easier to read than pure 90°
      const target = playerPos.clone().add(new THREE.Vector3(0, 22, 5)).add(shake);
      this.camera.up.set(0, 1, 0);
      this.camera.position.lerp(target, 0.15);
      this.camera.lookAt(playerPos);
    } else if (this.cameraMode === 'tactical') {
      // Strategic overview — pure top-down (or near-top-down) centered on the MAZE.
      // Height auto-sized so the whole maze fits with a small margin.
      const mazeWorldWidth = this.maze.width * TILE_SIZE;
      const mazeWorldHeight = this.maze.height * TILE_SIZE;
      const maxDim = Math.max(mazeWorldWidth, mazeWorldHeight);
      // FOV 75° → need distance D such that 2*D*tan(37.5°) ≥ maxDim → D ≥ maxDim/1.53
      // Use 0.85 multiplier of maxDim as the height (puts maxDim well within view)
      const tHeight = maxDim * 0.85;
      const tForward = maxDim * 0.08; // small tilt so we still see the 3D walls
      const target = new THREE.Vector3(0, tHeight, tForward).add(shake);
      this.camera.up.set(0, 1, 0);
      this.camera.position.lerp(target, 0.12);
      this.camera.lookAt(0, 0, 0); // maze center
    } else if (this.cameraMode === 'bird') {
      // Isometric corner — fixed offset, pretty for screenshots
      const target = playerPos.clone().add(new THREE.Vector3(15, 18, 15)).add(shake);
      this.camera.up.set(0, 1, 0);
      this.camera.position.lerp(target, 0.1);
      this.camera.lookAt(playerPos);
    } else /* cinematic */ {
      // Slow orbit around the player — film-trailer feel.
      // Fast lerp (0.2) so the camera tracks the moving orbit target without dragging behind.
      const angle = time * 0.25;                     // ~25 s/rev (slow)
      const orbitDist = 13;
      const baseHeight = 7;
      const heightBob = Math.sin(time * 0.5) * 1.2;  // gentle vertical drift
      const target = playerPos.clone().add(new THREE.Vector3(
        Math.cos(angle) * orbitDist,
        baseHeight + heightBob,
        Math.sin(angle) * orbitDist,
      )).add(shake);
      this.camera.up.set(0, 1, 0);
      this.camera.position.lerp(target, 0.2);
      this.camera.lookAt(playerPos.x, playerPos.y + 0.4, playerPos.z);
    }

    // Mini-map broadcast
    if (this.onStateUpdate) {
      this.onStateUpdate({
        p: { x: playerGridX, y: playerGridZ },
        e: this.enemies.map(e => ({
          x: Math.round((e.mesh.position.x / TILE_SIZE) + this.maze.width / 2),
          y: Math.round((e.mesh.position.z / TILE_SIZE) + this.maze.height / 2),
        })),
        cameraMode: this.cameraMode,
        canBuild: this.nearTowerSpot !== null && !this.quizLocked,
        heart: this.mode === 'heart_defense' ? { hp: this.heart.hp, maxHp: this.heart.maxHp } : null,
        unitsCount: this.units.length,
        unitsBuilt: this.unitsBuilt,
        enemiesKilled: this.enemiesKilled,
        // Wave state (only meaningful in wave-mode modes)
        wave: this.isWaveMode ? {
          number: this.waveNumber,
          active: this.waveActive,
          enemiesLeftInWave: this.enemiesRemainingThisWave + this.enemies.length,
          lullSecondsLeft: this.waveActive ? 0 : Math.max(0, this.waveLullDuration - this.waveLullTimer),
        } : null,
        pickups: this.pickups.map(p => ({ x: p.gridX, y: p.gridY, type: p.type })),
        recentPickup: this.lastPickupCollected,
      });
    }

    // Player visuals: rotate toward velocity only when actually moving, to avoid jitter at rest
    if (this.velocity.lengthSq() > 0.05) {
      const yaw = Math.atan2(this.velocity.x, this.velocity.z);
      this.playerObj.rotation.y = yaw;
    }
    this.playerObj.rotation.x = THREE.MathUtils.clamp(-this.velocity.z * 0.05, -0.3, 0.3);
    this.playerObj.rotation.z = THREE.MathUtils.clamp(this.velocity.x * 0.05, -0.3, 0.3);
    this.playerObj.position.y = 0.5 + Math.sin(time * 3) * 0.05;

    // Detect arrival on exit tile
    if (!this.hasExited && playerGridZ >= 0 && playerGridZ < this.maze.height
        && playerGridX >= 0 && playerGridX < this.maze.width
        && this.maze.grid[playerGridZ][playerGridX] === 5) {
      this.hasExited = true;
      this.onLevelComplete?.(this.player.score);
    }
  }

  /** External: called by App after any answer (correct or not). */
  public releaseQuizLock(_success: boolean) {
    this.quizLocked = false;
  }

  /**
   * Clear any held movement keys + velocity. Called when a quiz closes so the player
   * doesn't auto-resume charging into the door they just failed (or just passed through).
   */
  public clearInputs() {
    // Drop any pressed movement keys (the player likely held a direction when the QCM opened
    // and probably released them mentally during the quiz — re-press is required to resume)
    for (const k of Object.keys(this.keys)) {
      this.keys[k] = false;
    }
    this.touchVector.x = 0;
    this.touchVector.z = 0;
    this.velocity.set(0, 0, 0);
  }

  /** Returns true if the grid cell at world (px, pz) is blocking (wall or closed door). */
  private cellBlocks(px: number, pz: number): boolean {
    const tx = Math.round((px / TILE_SIZE) + this.maze.width / 2);
    const ty = Math.round((pz / TILE_SIZE) + this.maze.height / 2);
    if (tx < 0 || tx >= this.maze.width || ty < 0 || ty >= this.maze.height) return true;
    const tile = this.maze.grid[ty][tx];
    if (tile === 1) return true;
    if (tile === 2) {
      const door = this.maze.doors.find(d => d.x === tx && d.y === ty);
      return !door?.open;
    }
    return false;
  }

  /**
   * Radius-aware blocking check. Samples a few points around the position so the player
   * (or enemy) cannot visually overlap a wall — only the center cell is no longer enough.
   */
  private collideAt(pos: THREE.Vector3, radius: number): boolean {
    const offsets: [number, number][] = [
      [0, 0],
      [radius, 0], [-radius, 0],
      [0, radius], [0, -radius],
      [radius * 0.7, radius * 0.7], [-radius * 0.7, radius * 0.7],
      [radius * 0.7, -radius * 0.7], [-radius * 0.7, -radius * 0.7],
    ];
    for (const [ox, oz] of offsets) {
      if (this.cellBlocks(pos.x + ox, pos.z + oz)) return true;
    }
    return false;
  }

  /**
   * Trigger detection around the player center. Doors fire on the RISING EDGE only —
   * i.e. only when the player crosses into the proximity radius. Staying in the radius
   * (after a wrong answer for example) does not re-trigger; the player must step out
   * and back in. Tower spots remain explicit (E key only).
   */
  private checkTriggers(pos: THREE.Vector3) {
    const tx = Math.round((pos.x / TILE_SIZE) + this.maze.width / 2);
    const ty = Math.round((pos.z / TILE_SIZE) + this.maze.height / 2);

    const nowInRange = new Set<string>();
    let doorTriggered = false;

    const neighbourOffsets: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of neighbourOffsets) {
      const cx = tx + dx, cy = ty + dy;
      if (cx < 0 || cx >= this.maze.width || cy < 0 || cy >= this.maze.height) continue;
      if (this.maze.grid[cy][cx] !== 2) continue;
      const door = this.maze.doors.find(d => d.x === cx && d.y === cy);
      if (!door || door.open) continue;
      const doorWorldX = (cx - this.maze.width / 2) * TILE_SIZE;
      const doorWorldZ = (cy - this.maze.height / 2) * TILE_SIZE;
      const dist = Math.hypot(pos.x - doorWorldX, pos.z - doorWorldZ);
      if (dist > TILE_SIZE * 0.75) continue;

      const cellKey = `${cx},${cy}`;
      nowInRange.add(cellKey);

      // Rising edge: only fire when entering the range, not while we sit in it
      if (!this.inTriggerRange.has(cellKey) && !this.quizLocked && !doorTriggered) {
        this.quizLocked = true;
        this.onQuizTrigger('door', door);
        doorTriggered = true;
      }
    }
    this.inTriggerRange = nowInRange;

    if (doorTriggered) return;

    // Tower spot: mark as "nearby" — building happens only via explicit requestBuildTower()
    if (tx >= 0 && tx < this.maze.width && ty >= 0 && ty < this.maze.height
        && this.maze.grid[ty][tx] === 3) {
      const spot = this.maze.towerSpots.find(s => s.x === tx && s.y === ty);
      this.nearTowerSpot = spot && !spot.occupied ? spot : null;
    } else {
      this.nearTowerSpot = null;
    }
  }

  /** Public: cycle to the next camera mode (called by C key OR touch button). */
  public cycleCameraMode() {
    const modes: (typeof this.cameraMode)[] = ['follow', 'top', 'tactical', 'bird', 'cinematic'];
    const idx = modes.indexOf(this.cameraMode);
    this.cameraMode = modes[(idx + 1) % modes.length];
    AudioEngine.playClick();
  }

  /** Public: try to open a build QCM if the player is standing on a free tower spot. */
  public requestBuildTower() {
    const spot = this.nearTowerSpot;
    if (!spot || this.quizLocked) return;
    this.quizLocked = true;
    this.onQuizTrigger('tower', spot);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  loop() {
    if (!this.running) return;
    this.animationId = requestAnimationFrame(this.loop.bind(this));
    this.update();
    this.render();
  }

  stop() {
    this.running = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    window.removeEventListener('resize', this.boundResize);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.renderer.domElement.removeEventListener('click', this.boundClick);

    // Detach renderer DOM and release GPU resources
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach(m => m.dispose());
      else if (mat) mat.dispose();
    });
    this.renderer.dispose();
  }
}
