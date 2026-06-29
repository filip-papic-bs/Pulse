import * as limbo from "./limbo.mjs";
import * as plinko from "./plinko.mjs";
import * as dice from "./dice.mjs";
import * as mines from "./mines.mjs";
import * as blackjack from "./blackjack.mjs";
import * as slot from "./slot.mjs";
import * as keno from "./keno.mjs";
import * as chickNRun from "./chick-n-run.mjs";
import * as tower from "./tower.mjs";
import * as roulette from "./roulette.mjs";
import * as wheel from "./wheel.mjs";
import * as diamonds from "./diamonds.mjs";
import * as raRaRiches from "./ra-ra-riches.mjs";
import * as coinFlip from "./coin-flip.mjs";

const flows = {
  "limbo-originals": limbo,
  "plinko-originals": plinko,
  "dice-originals": dice,
  "mines-originals": mines,
  "blackjack-originals": blackjack,
  slot,
  keno,
  "chick-n-run": chickNRun,
  tower,
  roulette,
  "wheel-originals": wheel,
  diamonds,
  "ra-ra-riches": raRaRiches,
  "coin-flip": coinFlip,
};

export function flowFor(slug) {
  return flows[slug] ?? null;
}
