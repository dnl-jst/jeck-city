/**
 * Every physics number in one place. Units: metres, seconds, kilograms, radians, newtons.
 * Shared by client prediction and the authoritative server, so changing anything here changes both.
 */
export const TUNING = {
  world: {
    /** Fixed simulation step. Never derived from wall-clock time. */
    dt: 1 / 60,
    /** Gravity for dynamic bodies (cars). The character applies its own gravity below. */
    gravity: -9.81,
    /** Invisible boundary walls: one thin cuboid per boundary edge. */
    boundaryWallHeight: 4,
    boundaryWallThickness: 0.4,
    /** Longer triangle edges are subdivided before building the trimesh (precision, see world.ts). */
    maxTriangleEdge: 32,
  },

  character: {
    /** Capsule: radius and total height (feet to head). */
    radius: 0.3,
    height: 1.8,
    walkSpeed: 1.6,
    runSpeed: 5.5,
    /** Vertical acceleration applied by the character itself (m/s²). */
    gravity: -20,
    /** Take-off speed of a jump (m/s): apex jumpSpeed² / (2·|gravity|) ≈ 0.76 m. */
    jumpSpeed: 5.5,
    /** Character controller skin width: gap kept between capsule and obstacles. */
    skin: 0.02,
    /** Autostep: highest step climbed without jumping, and minimum free width on top of it. */
    stepMaxHeight: 0.25,
    stepMinWidth: 0.2,
    /** Pull down to the ground when walking off something lower than this (stairs, kerbs). */
    snapToGround: 0.3,
    /** Steepest walkable slope; steeper surfaces are slid down. */
    maxSlope: (45 * Math.PI) / 180,
  },

  /** Street furniture: trees are solid, lamps break off and topple when a car hits them hard enough. */
  props: {
    /** Lamp post collider (cylinder from the ground up). */
    lampRadius: 0.18,
    lampHeight: 6,
    /** Mass of a knocked-down lamp (kg). */
    lampMass: 180,
    /** A car this fast (horizontal, km/h) knocks a lamp over; slower it stops at the post as at a wall. */
    lampBreakKmh: 20,
    /** Only bodies at least this heavy break lamps (cars, not fallen lamps). */
    breakerMinMass: 500,
    /**
     * A falling lamp's centre starts at kick × the car's speed and spins forward at spin × speed rad/s, top away from
     * the car: foot at (kick − spin·h/2) ≈ 0.9 × speed, so the post stays ahead of the slowed car while it falls.
     */
    lampKick: 1.25,
    lampSpin: 0.12,
    /** Damping of a knocked-down lamp, so it comes to rest within a few seconds. */
    lampLinearDamping: 1,
    lampAngularDamping: 2,
    /** Tree trunk collider at scale 1 (render trunk: TREE_TRUNK_RADIUS in client trees.ts). */
    trunkRadius: 0.24,
    trunkHeight: 4.2,
    /** Traffic light pole (fixed, like a trunk; model: data/models/signals). */
    poleRadius: 0.06,
    poleHeight: 3.5,
  },

  /**
   * Known limitation (v1, revisit in Plan 2): characters are kinematic, i.e. immovable for dynamic
   * bodies, so a car that hits a person stops dead as if against a post. Wheel rays ignore characters.
   */
  vehicle: {
    /** Chassis box (full sizes): length along heading, height, width. */
    length: 4.2,
    height: 1.5,
    width: 1.8,
    mass: 1200,
    /** Centre of mass below the box centre (m). Keeps the car from tipping in sharp turns. */
    comDrop: 0.6,
    /** Extra damping so the car settles quickly instead of rocking (arcade feel). */
    linearDamping: 0.05,
    angularDamping: 0.8,

    maxForwardKmh: 60,
    maxReverseKmh: 20,
    /** Drive force of all four wheels together at full throttle. */
    engineForce: 6000,
    /** Engine force fades to zero over this many km/h below the top speed (soft limiter). */
    limiterBandKmh: 4,

    /** Brake impulse per wheel and step: brake button / throttle against direction of travel. 60 ≈ 1.1 g, ~10 m from 60 km/h. */
    brake: 60,
    /** Light brake when no throttle is given, so the car rolls to a stop. */
    coastBrake: 2,
    /** Parking brake of an unoccupied car. */
    parkingBrake: 50,

    /** Speed-sensitive steering: full lock below lowKmh, tapering linearly to highLock at highKmh. */
    steerLowLock: 0.6,
    steerHighLock: 0.15,
    steerLowKmh: 10,
    steerHighKmh: 60,
    /** How fast the wheels turn towards the requested angle (rad/s). */
    steerRate: 3,

    /** Wheels: positions in the chassis frame (x = half track, z = half wheelbase, y = mount height). */
    wheelX: 0.78,
    wheelZ: 1.35,
    wheelY: -0.35,
    wheelRadius: 0.34,
    /** Suspension: long rest length and travel so a 0.12 m kerb is absorbed, not a wall. */
    suspensionRest: 0.35,
    suspensionTravel: 0.3,
    suspensionStiffness: 30,
    suspensionCompression: 4.4,
    suspensionRelaxation: 2.3,
    maxSuspensionForce: 100_000,
    /** Tyre grip: high values = arcade, the car goes where it points. */
    frictionSlip: 3,
    sideFrictionStiffness: 1,
  },

  /** Bikes (per-type values in biketypes.ts BIKE_SPECS). */
  bike: {
    /** Rider capsule (feet on the pedals to the head) above the bike collider. */
    riderHeight: 1.8,
    /** Radius of the lying capsule along the bike. */
    colliderRadius: 0.35,
    /** Autostep: kerbs up to this height are ridden over; minimum free width on top. */
    stepMaxHeight: 0.2,
    stepMinWidth: 0.15,
    snapToGround: 0.35,
    gravity: -20,
    maxSlope: (40 * Math.PI) / 180,
    /** Rolling resistance without pedalling (m/s²), reverse push speed (km/h). */
    rollDecel: 0.6,
    reverseKmh: 4,
    /** Steering taper: full lock below lowKmh, highLock at highKmh. */
    steerLowKmh: 5,
    steerHighKmh: 35,
    /** Steering effect in the air (fraction). */
    airSteer: 0.3,
    /** Faster than this (km/h) into an obstacle more head-on than crashBlocked (cos of the angle to its normal): the rider falls. */
    crashKmh: 22,
    crashBlocked: 0.7,
    getUpSeconds: 1.1,
    /** Getting off faster than this (km/h) is a jump off; the bike rolls on. */
    dismountJumpKmh: 10,
    /** Parked bikes get a physics body within near (m) of the player, lose it beyond far. */
    parkedPhysicsNear: 60,
    parkedPhysicsFar: 80,
  },
} as const;
