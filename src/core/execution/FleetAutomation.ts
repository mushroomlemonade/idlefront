import {
  FleetOrdersSchema,
  type FleetOrders,
  type FleetView,
} from "../FleetOrders";
import {
  PlayerType,
  UnitType,
  type Execution,
  type Game,
  type Player,
} from "../game/Game";
import { type TileRef } from "../game/GameMap";
import { MoveWarshipExecution } from "./MoveWarshipExecution";
import { WarshipExecution } from "./WarshipExecution";

interface FleetState {
  view: FleetView;
  nextTick: number;
  cursor: number;
  manual: Set<number>;
  // Only automation-built ships are subject to standing orders.
  ships: Set<number>;
}
const fleets = new WeakMap<Player, FleetState>();
export function fleetView(player: Player): FleetView | undefined {
  return fleets.get(player)?.view;
}
export function fleetHash(player: Player): number {
  const s = fleets.get(player);
  if (!s) return 0;
  let hash = 17;
  const values = [
    Number(s.view.enabled),
    s.view.target,
    s.view.reserve,
    s.view.pending,
    s.nextTick,
    s.cursor,
    s.view.order === "defend" ? 1 : s.view.order === "escort" ? 2 : 3,
    s.view.patrolTile ?? -1,
    ...s.view.ports,
    -2,
    ...s.ships,
    -3,
    ...s.manual,
  ];
  for (const value of values) hash = (Math.imul(hash, 31) + value) | 0;
  if (s.view.automaticPorts) hash = (Math.imul(hash, 31) + 1) | 0;
  return hash;
}
function publish(
  s: FleetState,
  status: FleetView["status"],
  pending = s.view.pending,
) {
  if (status !== s.view.status || pending !== s.view.pending)
    s.view = { ...s.view, status, pending, revision: s.view.revision + 1 };
}
export function manuallyCommandFleetShip(player: Player, id: number): void {
  const s = fleets.get(player);
  if (s?.ships.has(id)) s.manual.add(id);
}
export function configureFleet(
  game: Game,
  player: Player,
  input: FleetOrders,
): void {
  if (player.type() !== PlayerType.Human) return;
  setFleetOrders(game, player, input);
}

/** Simulation-only entry point; client fleet intents remain human-only. */
export function configureNationFleet(
  game: Game,
  player: Player,
  input: FleetOrders,
): void {
  if (
    player.type() !== PlayerType.Nation ||
    game.config().gameConfig().nationStrategy !== "v2"
  )
    return;
  const prior = fleetView(player);
  if (
    prior &&
    prior.target === input.target &&
    prior.reserve === input.reserve &&
    prior.order === input.order &&
    prior.enabled === input.enabled &&
    prior.automaticPorts === input.automaticPorts &&
    prior.patrolTile === input.patrolTile &&
    prior.ports.length === input.ports.length &&
    prior.ports.every((id, i) => id === input.ports[i])
  )
    return;
  setFleetOrders(game, player, input);
}

function setFleetOrders(game: Game, player: Player, input: FleetOrders): void {
  const parsed = FleetOrdersSchema.safeParse(input);
  if (!parsed.success || !player.isAlive()) return;
  const orders = parsed.data;
  if (
    orders.order === "patrol" &&
    (orders.patrolTile === undefined ||
      !game.isValidRef(orders.patrolTile) ||
      !game.isWater(orders.patrolTile))
  )
    return;
  const owned = new Set(
    player
      .units(UnitType.Port)
      .filter((p) => p.isActive())
      .map((p) => p.id()),
  );
  if (orders.ports.some((id) => !owned.has(id))) return;
  const prior = fleets.get(player);
  fleets.set(player, {
    view: {
      ...orders,
      ports: [...new Set(orders.ports)],
      revision: (prior?.view.revision ?? 0) + 1,
      status: orders.enabled ? "target met" : "disabled",
      pending: 0,
    },
    nextTick: game.ticks() + 1,
    cursor: prior?.cursor ?? 0,
    manual: new Set(),
    ships: prior?.ships ?? new Set(),
  });
}
export class FleetOrdersExecution implements Execution {
  constructor(
    private player: Player,
    private orders: FleetOrders,
  ) {}
  init(game: Game): void {
    configureFleet(game, this.player, this.orders);
  }
  tick(): void {}
  isActive(): boolean {
    return false;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

function eligiblePorts(player: Player, s: FleetState) {
  const allowed = new Set(s.view.ports);
  return player
    .units(UnitType.Port)
    .filter(
      (p) =>
        (s.view.automaticPorts === true || allowed.has(p.id())) &&
        p.isActive() &&
        !p.isUnderConstruction(),
    );
}
function portWater(game: Game, tile: TileRef): TileRef | undefined {
  let water: TileRef | undefined;
  game.forEachNeighbor(tile, (t) => {
    if (water === undefined && game.isWater(t)) water = t;
  });
  return water;
}

/** One bounded, staggered pass per player every five simulation seconds. */
export function updateFleet(game: Game, player: Player): void {
  const s = fleets.get(player);
  if (
    !s ||
    !s.view.enabled ||
    !player.isAlive() ||
    game.inSpawnPhase() ||
    game.ticks() < s.nextTick
  )
    return;
  s.nextTick = game.ticks() + 50 + (player.smallID() % 10);
  if (game.config().isUnitDisabled(UnitType.Warship)) {
    publish(s, "unit disabled");
    return;
  }
  const ports = eligiblePorts(player, s);
  if (!ports.length) {
    publish(s, "no eligible port");
    return;
  }
  const ships = player.units(UnitType.Warship);
  const ownedShips = new Set(ships.map((ship) => ship.id()));
  for (const id of s.ships)
    if (!ownedShips.has(id)) {
      s.ships.delete(id);
      s.manual.delete(id);
    }

  const escorts =
    s.view.order === "escort"
      ? player.units(UnitType.TransportShip, UnitType.TradeShip).slice(0, 32)
      : [];
  let moved = 0;
  const homeWater = ports
    .slice(0, 64)
    .map((p) => portWater(game, p.tile()))
    .filter((t): t is TileRef => t !== undefined);
  for (const ship of ships) {
    if (
      !s.ships.has(ship.id()) ||
      s.manual.has(ship.id()) ||
      !ship.isActive() ||
      ship.isUnderConstruction()
    )
      continue;
    // Native repair/retreat must not be cancelled by automation.
    if (ship.warshipState().state !== "patrolling") continue;
    let destination: TileRef | undefined;
    if (s.view.order === "patrol") destination = s.view.patrolTile;
    else if (s.view.order === "escort")
      destination = escorts
        .find(
          (e) =>
            e.isActive() &&
            game.isWater(e.tile()) &&
            game.hasWaterComponent(
              ship.tile(),
              game.getWaterComponent(e.tile())!,
            ),
        )
        ?.tile();
    // Stable home assignment, no enemy intelligence or global scans.
    if (destination === undefined) {
      // A port across a disconnected ocean cannot be defended by this ship.
      for (let i = 0; i < homeWater.length; i++) {
        const candidate = homeWater[(ship.id() + i) % homeWater.length];
        const component = game.getWaterComponent(candidate);
        if (
          component !== null &&
          component !== undefined &&
          game.hasWaterComponent(ship.tile(), component)
        ) {
          destination = candidate;
          break;
        }
      }
    }
    if (
      destination !== undefined &&
      destination !== ship.warshipState().patrolTile &&
      (s.view.order !== "escort" ||
        ship.warshipState().patrolTile === undefined ||
        game.manhattanDist(destination, ship.warshipState().patrolTile!) >= 16)
    ) {
      game.addExecution(
        new MoveWarshipExecution(player, [ship.id()], destination, false),
      );
      if (++moved >= 4) break;
    }
  }
  if (ships.length + s.view.pending >= s.view.target) {
    publish(s, "target met");
    return;
  }
  const cost = game.unitInfo(UnitType.Warship).cost(game, player);
  if (player.gold() - cost < BigInt(s.view.reserve)) {
    publish(s, "reserve reached");
    return;
  }
  // At most eight local port candidates per decision; native spawn still decides legality.
  for (let i = 0; i < Math.min(8, ports.length); i++) {
    const port = ports[s.cursor++ % ports.length];
    const tile = portWater(game, port.tile());
    if (
      tile === undefined ||
      player.canBuild(UnitType.Warship, tile) !== port.tile()
    )
      continue;
    publish(s, "building", 1);
    // Revalidate at the native purchase, not merely when queued. Intervening
    // manual spending/capture/settings changes cannot bypass reserve or port selection.
    game.addExecution(
      new WarshipExecution(
        { owner: player, patrolTile: tile },
        {
          allowed: () =>
            fleets.get(player) === s &&
            s.view.enabled &&
            player.isAlive() &&
            port.isActive() &&
            port.owner() === player &&
            game.owner(port.tile()) === player &&
            !port.isUnderConstruction() &&
            player.unitCount(UnitType.Warship) < s.view.target &&
            player.gold() -
              game.unitInfo(UnitType.Warship).cost(game, player) >=
              BigInt(s.view.reserve) &&
            player.canBuild(UnitType.Warship, tile) === port.tile(),
          finished: (ship) => {
            if (ship) s.ships.add(ship.id());
            publish(s, ship ? "building" : "no valid build location", 0);
          },
        },
      ),
    );
    return;
  }
  publish(s, "no valid build location");
}
