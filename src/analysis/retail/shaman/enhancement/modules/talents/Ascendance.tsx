import Events, {
  AnyEvent,
  ApplyBuffEvent,
  CastEvent,
  DamageEvent,
  FightEndEvent,
  RefreshBuffEvent,
  UpdateSpellUsableEvent,
  UpdateSpellUsableType,
} from 'parser/core/Events';
import { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import { TALENTS_SHAMAN } from 'common/TALENTS';
import MajorCooldown, { CooldownTrigger } from 'parser/core/MajorCooldowns/MajorCooldown';
import SpellUsable from 'analysis/retail/shaman/enhancement/modules/core/SpellUsable';
import { ChecklistUsageInfo, SpellUse, UsageInfo } from 'parser/core/SpellUsage/core';
import { QualitativePerformance } from 'parser/ui/QualitativePerformance';
import { SpellLink } from 'interface';
import SPELLS, { maybeGetSpell } from 'common/SPELLS';
import Abilities from '../Abilities';
import Haste from 'parser/shared/modules/Haste';
import { THORIMS_INVOCATION_LINK } from 'analysis/retail/shaman/enhancement/modules/normalizers/EventLinkNormalizer';
import { combineQualitativePerformances } from 'common/combineQualitativePerformances';
import TalentSpellText from 'parser/ui/TalentSpellText';
import { formatNumber, formatPercentage } from 'common/format';
import STATISTIC_ORDER from 'parser/ui/STATISTIC_ORDER';
import STATISTIC_CATEGORY from 'parser/ui/STATISTIC_CATEGORY';
import Statistic from 'parser/ui/Statistic';
import Uptime from 'interface/icons/Uptime';
import typedKeys from 'common/typedKeys';
import SPELL_CATEGORY from 'parser/core/SPELL_CATEGORY';

const NonMissedCastSpells = [
  TALENTS_SHAMAN.SUNDERING_TALENT.id,
  TALENTS_SHAMAN.DOOM_WINDS_TALENT.id,
  TALENTS_SHAMAN.FERAL_SPIRIT_TALENT.id,
  SPELLS.WINDSTRIKE_CAST.id,
];
const SIMULATED_MEDIAN_CASTS_PER_DRE = 13;

interface Casts {
  count: number;
  noProcBeforeEnd?: boolean | undefined;
}

interface AscendanceCooldownCast
  extends CooldownTrigger<CastEvent | ApplyBuffEvent | RefreshBuffEvent> {
  casts: CastEvent[];
  extraDamage: number;
  startTime: number;
  endTime: number;
  hasteAdjustedWastedCooldown: number;
}

class Ascendance extends MajorCooldown<AscendanceCooldownCast> {
  static dependencies = {
    ...MajorCooldown.dependencies,
    haste: Haste,
    spellUsable: SpellUsable,
    abilities: Abilities,
  };

  protected haste!: Haste;
  protected spellUsable!: SpellUsable;
  protected abilities!: Abilities;

  protected currentCooldown: AscendanceCooldownCast | null = null;
  protected windstrikeOnCooldown: boolean = true;
  protected lastCooldownWasteCheck: number = 0;

  protected castsBeforeAscendanceProc: Casts[] = [{ count: 0 }];

  constructor(options: Options) {
    super({ spell: TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT }, options);
    this.active =
      this.selectedCombatant.hasTalent(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT) ||
      this.selectedCombatant.hasTalent(TALENTS_SHAMAN.DEEPLY_ROOTED_ELEMENTS_TALENT);
    if (!this.active) {
      return;
    }

    const abilities = options.abilities as Abilities;
    abilities.add({
      spell: SPELLS.WINDSTRIKE_CAST.id,
      category: SPELL_CATEGORY.ROTATIONAL,
      cooldown: (haste: number) => 3 / (1 + haste),
      gcd: {
        base: 1500,
      },
      castEfficiency: {
        suggestion: true,
        recommendedEfficiency: 0.8,
        maxCasts: () => this.maxCasts,
      },
    });

    if (this.selectedCombatant.hasTalent(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT)) {
      this.addEventListener(
        Events.cast.by(SELECTED_PLAYER).spell(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT),
        this.onAscendanceCast,
      );
    } else {
      this.addEventListener(
        Events.applybuff.by(SELECTED_PLAYER).spell(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT),
        this.onAscendanceCast,
      );
      this.addEventListener(
        Events.refreshbuff.by(SELECTED_PLAYER).spell(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT),
        this.onAscendanceCast,
      );
    }

    this.addEventListener(Events.cast.by(SELECTED_PLAYER), this.onGeneralCast);
    this.addEventListener(Events.damage.by(SELECTED_PLAYER), this.onDamage);
    this.addEventListener(
      Events.removebuff.by(SELECTED_PLAYER).spell(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT),
      this.onAscendanceEnd,
    );
    this.addEventListener(Events.fightend, this.onFightEnd);
    this.addEventListener(
      Events.UpdateSpellUsable.by(SELECTED_PLAYER).spell(SPELLS.WINDSTRIKE_CAST),
      this.detectWindstrikeCasts,
    );
    if (this.selectedCombatant.hasTalent(TALENTS_SHAMAN.DEEPLY_ROOTED_ELEMENTS_TALENT)) {
      this.addEventListener(
        Events.cast
          .by(SELECTED_PLAYER)
          .spell([TALENTS_SHAMAN.STORMSTRIKE_TALENT, SPELLS.WINDSTRIKE_CAST]),
        this.onProcEligibleCast,
      );
    }
  }

  detectWindstrikeCasts(event: UpdateSpellUsableEvent) {
    if (event.updateType === UpdateSpellUsableType.BeginCooldown) {
      this.windstrikeOnCooldown = true;
    }
    if (event.updateType === UpdateSpellUsableType.EndCooldown) {
      this.windstrikeOnCooldown = false;
      this.lastCooldownWasteCheck = event.timestamp;
    }
  }

  get maxCasts() {
    return this.casts.reduce(
      (total: number, cast: AscendanceCooldownCast) =>
        (total +=
          cast.casts.filter((c) => c.ability.guid === SPELLS.WINDSTRIKE_CAST.id).length +
          this.getMissedWindstrikes(cast)),
      0,
    );
  }

  /**
   * When Ascendance is cast, being recording the cooldown usage
   * @remarks
   * Deeply Rooted Elements appears as a fabricated cast
   */
  onAscendanceCast(event: CastEvent | ApplyBuffEvent | RefreshBuffEvent) {
    this.castsBeforeAscendanceProc.push({ count: 0 });
    this.currentCooldown ??= {
      event: event,
      casts: [],
      extraDamage: 0,
      startTime: event.timestamp,
      endTime: 0,
      hasteAdjustedWastedCooldown: 0,
    };
    this.lastCooldownWasteCheck = event.timestamp;
  }

  onGeneralCast(event: CastEvent) {
    if (
      !this.currentCooldown ||
      event.ability.guid === TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT.id ||
      !event.globalCooldown
    ) {
      return;
    }
    if (!NonMissedCastSpells.includes(event.ability.guid)) {
      this.currentCooldown.hasteAdjustedWastedCooldown +=
        this.hasteAdjustedCooldownWasteSinceLastWasteCheck(event);
    }
    this.lastCooldownWasteCheck = event.timestamp;
    this.currentCooldown!.casts.push(event);
  }

  onDamage(event: DamageEvent) {
    if (this.currentCooldown) {
      this.currentCooldown.extraDamage += event.amount;
    }
  }

  onAscendanceEnd(event: AnyEvent) {
    if (this.currentCooldown) {
      this.currentCooldown.endTime = event.timestamp;
      this.currentCooldown.hasteAdjustedWastedCooldown +=
        this.hasteAdjustedCooldownWasteSinceLastWasteCheck(event);
      this.recordCooldown(this.currentCooldown);
      this.currentCooldown = null;
    }
  }

  onProcEligibleCast(event: CastEvent) {
    this.castsBeforeAscendanceProc.at(-1)!.count += 1;
  }

  onFightEnd(event: FightEndEvent) {
    const cast = this.castsBeforeAscendanceProc.at(-1);
    if (cast) {
      cast.noProcBeforeEnd = true;
    }
    this.onAscendanceEnd(event);
  }

  hasteAdjustedCooldownWasteSinceLastWasteCheck(event: AnyEvent): number {
    const currentHaste = this.haste.current;
    return (event.timestamp - this.lastCooldownWasteCheck) * (1 + currentHaste);
  }

  description(): JSX.Element {
    return (
      <>
        <p>
          <strong>
            <SpellLink spell={TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT} />
          </strong>{' '}
          is a powerful{' '}
          {this.selectedCombatant.hasTalent(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT) ? (
            <>cooldow</>
          ) : (
            <>proc</>
          )}
          , which when combined with <SpellLink spell={TALENTS_SHAMAN.STATIC_ACCUMULATION_TALENT} />{' '}
          and
          <SpellLink spell={TALENTS_SHAMAN.THORIMS_INVOCATION_TALENT} /> has the potential for
          extemely high burst windows.
        </p>
        <p>
          Prioritising the correct abilities and having{' '}
          <SpellLink spell={TALENTS_SHAMAN.THORIMS_INVOCATION_TALENT} /> primed with{' '}
          <SpellLink spell={SPELLS.LIGHTNING_BOLT} /> is key to getting the most out of{' '}
          <SpellLink spell={TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT} />
        </p>
      </>
    );
  }

  getMissedWindstrikes(cast: AscendanceCooldownCast): number {
    return Math.floor(cast.hasteAdjustedWastedCooldown / 3000);
  }

  windstrikePerformance(cast: AscendanceCooldownCast): UsageInfo {
    const windstrikesCasts = cast.casts.filter(
      (c) => c.ability.guid === SPELLS.WINDSTRIKE_CAST.id,
    ).length;
    const missedWindstrikes = this.getMissedWindstrikes(cast);
    const maximumNumberOfWindstrikesPossible = windstrikesCasts + missedWindstrikes;
    const castsAsPercentageOfMax = windstrikesCasts / maximumNumberOfWindstrikesPossible;

    const windstrikeSummary = (
      <div>
        Cast {Math.floor(maximumNumberOfWindstrikesPossible * 0.85)}+{' '}
        <SpellLink spell={SPELLS.WINDSTRIKE_CAST} />
        (s) during window
      </div>
    );

    if (missedWindstrikes === 0) {
      return {
        performance: QualitativePerformance.Perfect,
        summary: windstrikeSummary,
        details: (
          <div>
            You cast {windstrikesCasts} <SpellLink spell={SPELLS.WINDSTRIKE_CAST} />
            (s).
          </div>
        ),
      };
    }

    return {
      performance:
        castsAsPercentageOfMax >= 0.8
          ? QualitativePerformance.Good
          : castsAsPercentageOfMax >= 0.6
          ? QualitativePerformance.Ok
          : QualitativePerformance.Fail,
      summary: windstrikeSummary,
      details: (
        <div>
          You cast {windstrikesCasts} <SpellLink spell={SPELLS.WINDSTRIKE_CAST} />
          (s) when you could have cast {maximumNumberOfWindstrikesPossible}
        </div>
      ),
    };
  }

  thorimsInvocationPerformance(cast: AscendanceCooldownCast): UsageInfo[] | undefined {
    const result: UsageInfo[] = [];
    const windstrikes = cast.casts.filter((c) => c.ability.guid === SPELLS.WINDSTRIKE_CAST.id);
    const thorimsInvocationFreeCasts = windstrikes.map((event: CastEvent) => {
      return event._linkedEvents
        ?.filter((le) => le.relation === THORIMS_INVOCATION_LINK)
        .map((le) => le.event as DamageEvent);
    });

    // casts without any maelstrom are bad casts, only relevant for elementalist builds that pick the Ascendance talent rather than storm using DRE
    const noMaelstromCasts =
      this.selectedCombatant.hasTalent(TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT) &&
      thorimsInvocationFreeCasts.filter((fc) => !fc).length;
    if (noMaelstromCasts) {
      result.push({
        performance: QualitativePerformance.Ok,
        summary: (
          <div>
            You cast <SpellLink spell={SPELLS.WINDSTRIKE_CAST} /> with no{' '}
            <SpellLink spell={SPELLS.MAELSTROM_WEAPON_BUFF} /> {noMaelstromCasts} time(s).
          </div>
        ),
        details: (
          <div>
            <SpellLink spell={SPELLS.WINDSTRIKE_CAST} /> has significantly lower priority when you
            have no stacks of <SpellLink spell={SPELLS.MAELSTROM_WEAPON_BUFF} />
          </div>
        ),
      });
    }

    const chainLightningCastsWith1Hit = thorimsInvocationFreeCasts.filter((fc) => {
      if (fc) {
        return (
          fc.filter((de) => de.ability.guid === TALENTS_SHAMAN.CHAIN_LIGHTNING_TALENT.id).length ===
          1
        );
      }
      return false;
    }).length;
    if (chainLightningCastsWith1Hit > 0) {
      result.push({
        performance: QualitativePerformance.Ok,
        summary: (
          <div>
            <SpellLink spell={TALENTS_SHAMAN.THORIMS_INVOCATION_TALENT} /> was primed with{' '}
            <SpellLink spell={TALENTS_SHAMAN.CHAIN_LIGHTNING_TALENT} />
          </div>
        ),
        details: (
          <div>
            <SpellLink spell={TALENTS_SHAMAN.THORIMS_INVOCATION_TALENT} /> cast
            <SpellLink spell={TALENTS_SHAMAN.CHAIN_LIGHTNING_TALENT} />{' '}
            {chainLightningCastsWith1Hit} time(s) only hitting one target.
          </div>
        ),
      });
    }
    return result.length > 0 ? result : undefined;
  }

  explainPerformance(cast: AscendanceCooldownCast): SpellUse {
    const checklistItems: ChecklistUsageInfo[] = [];

    const windstrikePerformance = this.windstrikePerformance(cast);
    const thorimsInvocationPerformance = this.thorimsInvocationPerformance(cast);

    checklistItems.push({
      check: 'windstrike',
      timestamp: cast.event.timestamp,
      ...windstrikePerformance,
    });

    if (thorimsInvocationPerformance) {
      thorimsInvocationPerformance.forEach((item) => {
        checklistItems.push({
          check: 'thorims-invocation',
          timestamp: cast.event.timestamp,
          ...item,
        });
      });
    }

    const actualPerformance = combineQualitativePerformances(
      checklistItems.map((item) => item.performance),
    );

    const fillerSpells = cast.casts
      .filter((c) => c.ability.guid !== SPELLS.WINDSTRIKE_CAST.id)
      .reduce((group: Record<number, number>, castEvent: CastEvent) => {
        group[castEvent.ability.guid] = group[castEvent.ability.guid] || 0;
        group[castEvent.ability.guid] += 1;
        return group;
      }, {});

    const fillerSpellsList = typedKeys(fillerSpells).map((spellId) => {
      const casts = fillerSpells[spellId];
      const spell = maybeGetSpell(spellId);
      return (
        spell && (
          <>
            <li key={`${cast.startTime}-${spellId}`}>
              <div>
                {casts} x <SpellLink spell={spell} />
              </div>
            </li>
          </>
        )
      );
    });

    return {
      event: cast.event,
      checklistItems: checklistItems,
      performance: actualPerformance,
      performanceExplanation:
        actualPerformance !== QualitativePerformance.Fail
          ? `${actualPerformance} Usage`
          : 'Bad Usage',
      extraDetails: fillerSpellsList.length > 0 && (
        <>
          Filler spells cast
          <ul>{fillerSpellsList}</ul>
        </>
      ),
    };
  }

  statistic() {
    if (this.selectedCombatant.hasTalent(TALENTS_SHAMAN.DEEPLY_ROOTED_ELEMENTS_TALENT)) {
      // don't include casts that didn't lead to a proc in casts per proc statistic
      const castsBeforeAscendanceProc = this.castsBeforeAscendanceProc
        .filter((cast: Casts) => !cast.noProcBeforeEnd)
        .map((cast: Casts) => cast.count);
      const minToProc = Math.min(...castsBeforeAscendanceProc);
      const maxToProc = Math.max(...castsBeforeAscendanceProc);
      const median = getMedian(castsBeforeAscendanceProc)!;
      // do include them in overall casts to get the expected procs based on simulation results
      const totalCasts = this.castsBeforeAscendanceProc.reduce(
        (total, current: Casts) => (total += current.count),
        0,
      );
      return (
        <Statistic
          position={STATISTIC_ORDER.OPTIONAL()}
          category={STATISTIC_CATEGORY.TALENTS}
          size="flexible"
          tooltip={
            <>
              <ul>
                <li>Min casts before proc: {minToProc}</li>
                <li>Max casts before proc: {maxToProc}</li>
                <li>Total casts: {totalCasts}</li>
                <li>Expected procs: {formatNumber(totalCasts / SIMULATED_MEDIAN_CASTS_PER_DRE)}</li>
              </ul>
            </>
          }
        >
          <TalentSpellText talent={TALENTS_SHAMAN.DEEPLY_ROOTED_ELEMENTS_TALENT}>
            <div>
              {formatNumber(median)} <small>casts per proc</small>
            </div>
            <div>
              {formatNumber(castsBeforeAscendanceProc.length)}{' '}
              <small>
                <SpellLink spell={TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT} /> procs
              </small>
            </div>
            <div>
              <Uptime />{' '}
              {formatPercentage(
                this.selectedCombatant.getBuffUptime(
                  TALENTS_SHAMAN.ASCENDANCE_ENHANCEMENT_TALENT.id,
                ) / this.owner.fightDuration,
                2,
              )}
              % <small>uptime</small>
            </div>
          </TalentSpellText>
        </Statistic>
      );
    }
  }
}

function getMedian(values: number[]): number | undefined {
  if (values.length > 0) {
    values.sort(function (a, b) {
      return a - b;
    });
    const half = Math.floor(values.length / 2);
    if (values.length % 2) {
      return values[half];
    }
    return (values[half - 1] + values[half]) / 2.0;
  }
}

export default Ascendance;
