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

    /** Brake strength per wheel: brake button / throttle against direction of travel. */
    brake: 25,
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
} as const;
