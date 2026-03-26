/**
 * Copy Trading Strategy Configuration
 *
 * This module defines the strategy for copying trades from followed traders.
 * Three strategies are supported:
 * - PERCENTAGE: Copy a fixed percentage of trader's order size
 * - FIXED: Copy a fixed dollar amount per trade
 * - ADAPTIVE: Dynamically adjust percentage based on trader's order size
 */

export enum CopyStrategy {
    PERCENTAGE = 'PERCENTAGE',
    FIXED = 'FIXED',
    ADAPTIVE = 'ADAPTIVE',
    BALANCE_PERCENTAGE = 'BALANCE_PERCENTAGE',  // Use X% of YOUR balance per trade
    MIRROR_ALLOCATION = 'MIRROR_ALLOCATION',    // Mirror trader's portfolio allocation %
}

/**
 * Tier definition for tiered multipliers
 * Example: { min: 100, max: 500, multiplier: 0.2 }
 * means trades between $100-$500 use 0.2x multiplier
 */
export interface MultiplierTier {
    min: number;          // Minimum trade size in USD (inclusive)
    max: number | null;   // Maximum trade size in USD (exclusive), null = infinity
    multiplier: number;   // Multiplier to apply
}

export interface CopyStrategyConfig {
    // Core strategy
    strategy: CopyStrategy;

    // Main parameter (meaning depends on strategy)
    // PERCENTAGE: Percentage of trader's order (e.g., 10.0 = 10%)
    // FIXED: Fixed dollar amount per trade (e.g., 50.0 = $50)
    // ADAPTIVE: Base percentage for adaptive scaling
    copySize: number;

    // Adaptive strategy parameters (only used if strategy = ADAPTIVE)
    adaptiveMinPercent?: number; // Minimum percentage for large orders
    adaptiveMaxPercent?: number; // Maximum percentage for small orders
    adaptiveThreshold?: number; // Threshold in USD to trigger adaptation

    // Tiered multipliers (optional - applies to all strategies)
    // If set, multiplier is applied based on trader's order size
    tieredMultipliers?: MultiplierTier[];

    // Legacy single multiplier (for backward compatibility)
    // Ignored if tieredMultipliers is set
    tradeMultiplier?: number;

    // Safety limits
    maxOrderSizeUSD: number; // Maximum size for a single order
    minOrderSizeUSD: number; // Minimum size for a single order
    maxPositionSizeUSD?: number; // Maximum total size for a position (optional)
    maxDailyVolumeUSD?: number; // Maximum total volume per day (optional)
}

export interface OrderSizeCalculation {
    traderOrderSize: number; // Original trader's order size
    baseAmount: number; // Calculated amount before limits
    finalAmount: number; // Final amount after applying limits
    strategy: CopyStrategy; // Strategy used
    cappedByMax: boolean; // Whether capped by MAX_ORDER_SIZE
    reducedByBalance: boolean; // Whether reduced due to balance
    belowMinimum: boolean; // Whether below minimum threshold
    reasoning: string; // Human-readable explanation
    traderPortfolioValue?: number; // Trader's total portfolio value (for MIRROR_ALLOCATION)
    traderAllocationPercent?: number; // % of trader's portfolio this trade represents
}

/**
 * Calculate order size based on copy strategy
 *
 * @param config - Copy strategy configuration
 * @param traderOrderSize - The trader's order size in USD
 * @param availableBalance - Your available balance in USD
 * @param currentPositionSize - Current position size for position limit checks
 * @param traderPortfolioValue - Trader's total portfolio value (required for MIRROR_ALLOCATION)
 */
export function calculateOrderSize(
    config: CopyStrategyConfig,
    traderOrderSize: number,
    availableBalance: number,
    currentPositionSize: number = 0,
    traderPortfolioValue?: number
): OrderSizeCalculation {
    let baseAmount: number;
    let reasoning: string;
    let traderAllocationPercent: number | undefined;

    // Step 1: Calculate base amount based on strategy
    switch (config.strategy) {
        case CopyStrategy.PERCENTAGE:
            baseAmount = traderOrderSize * (config.copySize / 100);
            reasoning = `${config.copySize}% of trader's $${traderOrderSize.toFixed(2)} = $${baseAmount.toFixed(2)}`;
            break;

        case CopyStrategy.FIXED:
            baseAmount = config.copySize;
            reasoning = `Fixed amount: $${baseAmount.toFixed(2)}`;
            break;

        case CopyStrategy.ADAPTIVE:
            const adaptivePercent = calculateAdaptivePercent(config, traderOrderSize);
            baseAmount = traderOrderSize * (adaptivePercent / 100);
            reasoning = `Adaptive ${adaptivePercent.toFixed(1)}% of trader's $${traderOrderSize.toFixed(2)} = $${baseAmount.toFixed(2)}`;
            break;

        case CopyStrategy.BALANCE_PERCENTAGE:
            // Use X% of YOUR balance per trade
            baseAmount = availableBalance * (config.copySize / 100);
            reasoning = `${config.copySize}% of your balance ($${availableBalance.toFixed(2)}) = $${baseAmount.toFixed(2)}`;
            break;

        case CopyStrategy.MIRROR_ALLOCATION:
            // Mirror the trader's allocation % of their portfolio
            if (!traderPortfolioValue || traderPortfolioValue <= 0) {
                // Fallback to PERCENTAGE if trader portfolio value not available
                baseAmount = traderOrderSize * (config.copySize / 100);
                reasoning = `Mirror fallback (no portfolio data): ${config.copySize}% of trader's $${traderOrderSize.toFixed(2)} = $${baseAmount.toFixed(2)}`;
            } else {
                // Calculate what % of their portfolio the trader is spending
                traderAllocationPercent = (traderOrderSize / traderPortfolioValue) * 100;
                // Apply that same % to your balance, scaled by copySize (100 = exact match)
                const scaleFactor = config.copySize / 100;
                baseAmount = availableBalance * (traderAllocationPercent / 100) * scaleFactor;
                reasoning = `Mirror: Trader spending ${traderAllocationPercent.toFixed(2)}% of $${traderPortfolioValue.toFixed(2)} → ${(traderAllocationPercent * scaleFactor).toFixed(2)}% of your $${availableBalance.toFixed(2)} = $${baseAmount.toFixed(2)}`;
            }
            break;

        default:
            throw new Error(`Unknown strategy: ${config.strategy}`);
    }

    // Step 1.5: Apply tiered or single multiplier based on trader's order size
    const multiplier = getTradeMultiplier(config, traderOrderSize);
    let finalAmount = baseAmount * multiplier;

    if (multiplier !== 1.0) {
        reasoning += ` → ${multiplier}x multiplier: $${baseAmount.toFixed(2)} → $${finalAmount.toFixed(2)}`;
    }
    let cappedByMax = false;
    let reducedByBalance = false;
    let belowMinimum = false;

    // Step 2: Apply maximum order size limit
    if (finalAmount > config.maxOrderSizeUSD) {
        finalAmount = config.maxOrderSizeUSD;
        cappedByMax = true;
        reasoning += ` → Capped at max $${config.maxOrderSizeUSD}`;
    }

    // Step 3: Apply maximum position size limit (if configured)
    if (config.maxPositionSizeUSD) {
        const newTotalPosition = currentPositionSize + finalAmount;
        if (newTotalPosition > config.maxPositionSizeUSD) {
            const allowedAmount = Math.max(0, config.maxPositionSizeUSD - currentPositionSize);
            if (allowedAmount < config.minOrderSizeUSD) {
                finalAmount = 0;
                reasoning += ` → Position limit reached`;
            } else {
                finalAmount = allowedAmount;
                reasoning += ` → Reduced to fit position limit`;
            }
        }
    }

    // Step 4: Check available balance (with 1% safety buffer)
    const maxAffordable = availableBalance * 0.99;
    if (finalAmount > maxAffordable) {
        finalAmount = maxAffordable;
        reducedByBalance = true;
        reasoning += ` → Reduced to fit balance ($${maxAffordable.toFixed(2)})`;
    }

    // Step 5: Check minimum order size
    if (finalAmount < config.minOrderSizeUSD) {
        belowMinimum = true;
        reasoning += ` → Below minimum $${config.minOrderSizeUSD}`;
        finalAmount = 0; // Don't execute
    }

    return {
        traderOrderSize,
        baseAmount,
        finalAmount,
        strategy: config.strategy,
        cappedByMax,
        reducedByBalance,
        belowMinimum,
        reasoning,
        traderPortfolioValue,
        traderAllocationPercent,
    };
}

/**
 * Calculate adaptive percentage based on trader's order size
 *
 * Logic:
 * - Small orders (< threshold): Use higher percentage (up to maxPercent)
 * - Large orders (> threshold): Use lower percentage (down to minPercent)
 * - Medium orders: Linear interpolation between copySize and min/max
 */
function calculateAdaptivePercent(config: CopyStrategyConfig, traderOrderSize: number): number {
    const minPercent = config.adaptiveMinPercent ?? config.copySize;
    const maxPercent = config.adaptiveMaxPercent ?? config.copySize;
    const threshold = config.adaptiveThreshold ?? 500;

    if (traderOrderSize >= threshold) {
        // Large order: scale down to minPercent
        // At threshold = minPercent, at 10x threshold = minPercent
        const factor = Math.min(1, traderOrderSize / threshold - 1);
        return lerp(config.copySize, minPercent, factor);
    } else {
        // Small order: scale up to maxPercent
        // At $0 = maxPercent, at threshold = copySize
        const factor = traderOrderSize / threshold;
        return lerp(maxPercent, config.copySize, factor);
    }
}

/**
 * Linear interpolation between two values
 */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Validate copy strategy configuration
 */
export function validateCopyStrategyConfig(config: CopyStrategyConfig): string[] {
    const errors: string[] = [];

    // Validate copySize
    if (config.copySize <= 0) {
        errors.push('copySize must be positive');
    }

    if (config.strategy === CopyStrategy.PERCENTAGE && config.copySize > 100) {
        errors.push('copySize for PERCENTAGE strategy should be <= 100');
    }

    // Validate limits
    if (config.maxOrderSizeUSD <= 0) {
        errors.push('maxOrderSizeUSD must be positive');
    }

    if (config.minOrderSizeUSD <= 0) {
        errors.push('minOrderSizeUSD must be positive');
    }

    if (config.minOrderSizeUSD > config.maxOrderSizeUSD) {
        errors.push('minOrderSizeUSD cannot be greater than maxOrderSizeUSD');
    }

    // Validate adaptive parameters
    if (config.strategy === CopyStrategy.ADAPTIVE) {
        if (!config.adaptiveMinPercent || !config.adaptiveMaxPercent) {
            errors.push('ADAPTIVE strategy requires adaptiveMinPercent and adaptiveMaxPercent');
        }

        if (config.adaptiveMinPercent && config.adaptiveMaxPercent) {
            if (config.adaptiveMinPercent > config.adaptiveMaxPercent) {
                errors.push('adaptiveMinPercent cannot be greater than adaptiveMaxPercent');
            }
        }
    }

    return errors;
}

/**
 * Get recommended configuration for different balance sizes
 */
export function getRecommendedConfig(balanceUSD: number): CopyStrategyConfig {
    if (balanceUSD < 500) {
        // Small balance: Conservative
        return {
            strategy: CopyStrategy.PERCENTAGE,
            copySize: 5.0,
            maxOrderSizeUSD: 20.0,
            minOrderSizeUSD: 1.0,
            maxPositionSizeUSD: 50.0,
            maxDailyVolumeUSD: 100.0,
        };
    } else if (balanceUSD < 2000) {
        // Medium balance: Balanced
        return {
            strategy: CopyStrategy.PERCENTAGE,
            copySize: 10.0,
            maxOrderSizeUSD: 50.0,
            minOrderSizeUSD: 1.0,
            maxPositionSizeUSD: 200.0,
            maxDailyVolumeUSD: 500.0,
        };
    } else {
        // Large balance: Adaptive
        return {
            strategy: CopyStrategy.ADAPTIVE,
            copySize: 10.0,
            adaptiveMinPercent: 5.0,
            adaptiveMaxPercent: 15.0,
            adaptiveThreshold: 300.0,
            maxOrderSizeUSD: 100.0,
            minOrderSizeUSD: 1.0,
            maxPositionSizeUSD: 1000.0,
            maxDailyVolumeUSD: 2000.0,
        };
    }
}

/**
 * Parse tiered multipliers from environment string
 * Format: "1-10:2.0,10-100:1.0,100-500:0.2,500+:0.1"
 *
 * @param tiersStr - Comma-separated tier definitions
 * @returns Array of MultiplierTier objects, sorted by min value
 * @throws Error if format is invalid
 */
export function parseTieredMultipliers(tiersStr: string): MultiplierTier[] {
    if (!tiersStr || tiersStr.trim() === '') {
        return [];
    }

    const tiers: MultiplierTier[] = [];
    const tierDefs = tiersStr.split(',').map(t => t.trim()).filter(t => t);

    for (const tierDef of tierDefs) {
        // Format: "min-max:multiplier" or "min+:multiplier"
        const parts = tierDef.split(':');
        if (parts.length !== 2) {
            throw new Error(`Invalid tier format: "${tierDef}". Expected "min-max:multiplier" or "min+:multiplier"`);
        }

        const [range, multiplierStr] = parts;
        const multiplier = parseFloat(multiplierStr);

        if (isNaN(multiplier) || multiplier < 0) {
            throw new Error(`Invalid multiplier in tier "${tierDef}": ${multiplierStr}`);
        }

        // Parse range
        if (range.endsWith('+')) {
            // Infinite upper bound: "500+"
            const min = parseFloat(range.slice(0, -1));
            if (isNaN(min) || min < 0) {
                throw new Error(`Invalid minimum value in tier "${tierDef}": ${range}`);
            }
            tiers.push({ min, max: null, multiplier });
        } else if (range.includes('-')) {
            // Bounded range: "100-500"
            const [minStr, maxStr] = range.split('-');
            const min = parseFloat(minStr);
            const max = parseFloat(maxStr);

            if (isNaN(min) || min < 0) {
                throw new Error(`Invalid minimum value in tier "${tierDef}": ${minStr}`);
            }
            if (isNaN(max) || max <= min) {
                throw new Error(`Invalid maximum value in tier "${tierDef}": ${maxStr} (must be > ${min})`);
            }

            tiers.push({ min, max, multiplier });
        } else {
            throw new Error(`Invalid range format in tier "${tierDef}". Use "min-max" or "min+"`);
        }
    }

    // Sort tiers by min value
    tiers.sort((a, b) => a.min - b.min);

    // Validate no overlaps and no gaps
    for (let i = 0; i < tiers.length - 1; i++) {
        const current = tiers[i];
        const next = tiers[i + 1];

        if (current.max === null) {
            throw new Error(`Tier with infinite upper bound must be last: ${current.min}+`);
        }

        if (current.max > next.min) {
            throw new Error(`Overlapping tiers: [${current.min}-${current.max}] and [${next.min}-${next.max || '∞'}]`);
        }
    }

    return tiers;
}

/**
 * Get the appropriate multiplier for a given trade size
 *
 * @param config - Copy strategy configuration
 * @param traderOrderSize - Trader's order size in USD
 * @returns Multiplier to apply (1.0 if no multiplier configured)
 */
export function getTradeMultiplier(config: CopyStrategyConfig, traderOrderSize: number): number {
    // Use tiered multipliers if configured
    if (config.tieredMultipliers && config.tieredMultipliers.length > 0) {
        for (const tier of config.tieredMultipliers) {
            if (traderOrderSize >= tier.min) {
                if (tier.max === null || traderOrderSize < tier.max) {
                    return tier.multiplier;
                }
            }
        }
        // If no tier matches, use the last tier's multiplier
        return config.tieredMultipliers[config.tieredMultipliers.length - 1].multiplier;
    }

    // Fall back to single multiplier if configured
    if (config.tradeMultiplier !== undefined) {
        return config.tradeMultiplier;
    }

    // Default: no multiplier
    return 1.0;
}

/**
 * Per-trader configuration interface
 * Used to override global settings for specific traders
 */
export interface TraderConfig {
    address: string;              // Trader's Ethereum address (lowercase)
    strategy?: CopyStrategy;      // Override strategy for this trader
    copySize?: number;            // Override copy size for this trader
    maxOrderSizeUSD?: number;     // Override max order size for this trader
    minOrderSizeUSD?: number;     // Override min order size for this trader
    maxPositionSizeUSD?: number;  // Override max position size for this trader
    maxDailyVolumeUSD?: number;   // Override max daily volume for this trader
    tieredMultipliers?: MultiplierTier[]; // Override tiered multipliers for this trader
    tradeMultiplier?: number;     // Override single trade multiplier for this trader
    // Adaptive parameters
    adaptiveMinPercent?: number;
    adaptiveMaxPercent?: number;
    adaptiveThreshold?: number;
}

/**
 * Parse per-trader configurations from JSON string
 *
 * @param traderConfigsStr - JSON string containing array of TraderConfig objects
 * @returns Map of lowercase address -> TraderConfig
 * @throws Error if JSON is invalid or addresses are malformed
 */
export function parseTraderConfigs(traderConfigsStr: string): Map<string, TraderConfig> {
    const configMap = new Map<string, TraderConfig>();

    if (!traderConfigsStr || traderConfigsStr.trim() === '') {
        return configMap;
    }

    let configs: TraderConfig[];
    try {
        configs = JSON.parse(traderConfigsStr);
    } catch (e) {
        throw new Error(
            `Invalid TRADER_CONFIGS JSON: ${e instanceof Error ? e.message : String(e)}`
        );
    }

    if (!Array.isArray(configs)) {
        throw new Error('TRADER_CONFIGS must be a JSON array');
    }

    for (const config of configs) {
        if (!config.address) {
            throw new Error('Each trader config must have an "address" field');
        }

        // Validate and normalize address
        const address = config.address.toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(address)) {
            throw new Error(`Invalid Ethereum address in TRADER_CONFIGS: ${config.address}`);
        }

        // Validate strategy if provided
        if (config.strategy) {
            const strategyStr = config.strategy.toUpperCase();
            if (!Object.values(CopyStrategy).includes(strategyStr as CopyStrategy)) {
                throw new Error(
                    `Invalid strategy "${config.strategy}" for trader ${address}. Valid strategies: ${Object.values(CopyStrategy).join(', ')}`
                );
            }
            config.strategy = strategyStr as CopyStrategy;
        }

        // Validate numeric fields
        if (config.copySize !== undefined && config.copySize <= 0) {
            throw new Error(`copySize must be positive for trader ${address}`);
        }
        if (config.maxOrderSizeUSD !== undefined && config.maxOrderSizeUSD <= 0) {
            throw new Error(`maxOrderSizeUSD must be positive for trader ${address}`);
        }
        if (config.minOrderSizeUSD !== undefined && config.minOrderSizeUSD <= 0) {
            throw new Error(`minOrderSizeUSD must be positive for trader ${address}`);
        }

        configMap.set(address, { ...config, address });
    }

    return configMap;
}

/**
 * Merge trader-specific config with global config
 * Trader-specific values override global values
 *
 * @param traderConfig - Per-trader configuration (partial)
 * @param globalConfig - Global default configuration
 * @returns Complete CopyStrategyConfig for this trader
 */
export function mergeTraderConfig(
    traderConfig: TraderConfig | undefined,
    globalConfig: CopyStrategyConfig
): CopyStrategyConfig {
    if (!traderConfig) {
        return globalConfig;
    }

    return {
        strategy: traderConfig.strategy ?? globalConfig.strategy,
        copySize: traderConfig.copySize ?? globalConfig.copySize,
        maxOrderSizeUSD: traderConfig.maxOrderSizeUSD ?? globalConfig.maxOrderSizeUSD,
        minOrderSizeUSD: traderConfig.minOrderSizeUSD ?? globalConfig.minOrderSizeUSD,
        maxPositionSizeUSD: traderConfig.maxPositionSizeUSD ?? globalConfig.maxPositionSizeUSD,
        maxDailyVolumeUSD: traderConfig.maxDailyVolumeUSD ?? globalConfig.maxDailyVolumeUSD,
        tieredMultipliers: traderConfig.tieredMultipliers ?? globalConfig.tieredMultipliers,
        tradeMultiplier: traderConfig.tradeMultiplier ?? globalConfig.tradeMultiplier,
        adaptiveMinPercent: traderConfig.adaptiveMinPercent ?? globalConfig.adaptiveMinPercent,
        adaptiveMaxPercent: traderConfig.adaptiveMaxPercent ?? globalConfig.adaptiveMaxPercent,
        adaptiveThreshold: traderConfig.adaptiveThreshold ?? globalConfig.adaptiveThreshold,
    };
}
