import express from "express";
import cors from "cors";
import OpenAI from "openai";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Language utility function - supports all formats
function getLanguageLabel(lang: string): string {
  if (!lang) return 'English';
  
  const normalizedLang = lang.toLowerCase();
  
  // Handle all Spanish variants
  if (normalizedLang.startsWith('es')) {
    return 'Spanish';
  }
  // Handle all Slovak variants
  if (normalizedLang.startsWith('sk')) {
    return 'Slovak';
  }
  // Handle all English variants (default)
  return 'English';
}

// Normalize language code to full locale format
function normalizeLanguageCode(lang: string): string {
  if (!lang) return 'en-us';
  
  const normalizedLang = lang.toLowerCase();
  
  // Handle all Spanish variants
  if (normalizedLang.startsWith('es')) {
    return 'es-pe';
  }
  // Handle all Slovak variants
  if (normalizedLang.startsWith('sk')) {
    return 'sk-sk';
  }
  // Handle all English variants (default)
  return 'en-us';
}

const app = express();
const port = parseInt(process.env.PORT || '8080', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));





// External AI processor using cost-effective models while maintaining quality for financial analysis
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// DeepSeek API client - mimics OpenAI interface
class DeepSeekClient {
  private apiKey: string;
  private baseURL: string = 'https://api.deepseek.com/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  chat = {
    completions: {
      create: async (params: any) => {
        try {
          const response = await axios.post(`${this.baseURL}/chat/completions`, {
            model: params.model,
            messages: params.messages,
            temperature: params.temperature || 0.7,
            max_tokens: params.max_tokens || 4000,
            response_format: params.response_format
          }, {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            }
          });

          // Return in OpenAI compatible format
          return {
            choices: [{
              message: {
                content: response.data.choices[0].message.content
              }
            }]
          };
        } catch (error) {
          console.error('DeepSeek API error:', error);
          throw error;
        }
      }
    }
  };
}

const deepseek = new DeepSeekClient(process.env.DEEPSEEK_API_KEY || '');

// Model selection function - now using OpenAI gpt-4o-mini by default
function getAIClient(useDeepSeek: boolean = false) {
  return useDeepSeek ? deepseek : openai;
}

export interface ExpenseCategorizationResult {
  category: string;
  confidence: number;
  reasoning: string;
}

export interface FinancialTip {
  title: string;
  description: string;
  category: 'spending' | 'saving' | 'budgeting' | 'income' | 'education';
  priority: 'high' | 'medium' | 'low';
  actionable: boolean;
  estimatedSaving?: number;
  educational?: boolean;
}

export interface TrendPrediction {
  category: string;
  predictedAmount: number;
  confidence: number;
  trend: 'increasing' | 'decreasing' | 'stable';
  reasoning: string;
  monthlyForecast: Array<{
    month: string;
    predicted: number;
    confidence: number;
  }>;
}

export interface FinancialForecast {
  nextMonthExpenses: number;
  expectedSavings: number;
  budgetVariance: number;
  confidence: number;
  keyInsights: string[];
  recommendations: Array<{
    id: string;
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    actionable: boolean;
    estimatedSaving?: number;
  }>;
  riskFactors: string[];
}

export interface ExpensePrediction {
  categoryPredictions: Array<{
    category: string;
    currentMonth: number;
    predictedNext: number;
    confidence: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    factors: string[];
  }>;
  monthlyPredictions: Array<{
    month: string;
    predicted: number;
    confidence: number;
    breakdown: Array<{
      category: string;
      amount: number;
    }>;
  }>;
}

export interface FinancialHealthData {
  score: number;
  trend: 'improving' | 'declining' | 'stable';
  category: 'excellent' | 'good' | 'fair' | 'poor';
  insights: string[];
  achievements: string[];
  warnings: string[];
}

// New function for user-specific categorization with existing categories
export async function categorizeExpenseWithUserCategories(
  description: string, 
  amount: number, 
  userCategories: Array<{id: number, name: string, type: string}>,
  language: string = 'en-us'
): Promise<{categoryId?: number, suggestedCategory?: string, confidence: number, reasoning: string}> {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    const userCategoryList = userCategories.map(cat => `- ${cat.name} (ID: ${cat.id})`).join('\n');
    
    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content must be in ${getLanguageLabel(normalizedLanguage)}.

You are an expert financial categorization assistant with deep knowledge of merchants, businesses, and spending patterns. Your task is to analyze transactions and either:
1. Match them to the user's existing categories, OR
2. Suggest a new category if none of the existing ones fit

USER'S EXISTING CATEGORIES:
${userCategoryList}

MERCHANT ANALYSIS RULES:
- Analyze the merchant name, transaction description, and amount to understand the business type
- Recognize common merchant patterns:
  * Grocery stores: Walmart, Target, Kroger, Safeway, Whole Foods, local markets, Migros, Coop, ALDI, Lidl
  * Restaurants: McDonald's, Starbucks, local restaurant names, delivery services
  * Gas stations: Shell, BP, Exxon, Chevron, local fuel stops
  * Utilities: Electric company, gas company, water department, internet providers, yallo.ch
  * Retail: Amazon, department stores, clothing stores, electronics stores
  * Healthcare: Pharmacy, doctor offices, hospitals, dental clinics, Amavita
  * Transportation: Uber, Lyft, taxi services, parking, tolls, public transit
  * Entertainment: Netflix, Spotify, movie theaters, gaming, streaming services, SoundCloud
  * Financial: Bank fees, interest charges, loan payments, insurance
  * Home/Maintenance: Hardware stores, contractors, cleaning services, repairs
  * Business: Replit, OpenAI, Hostinger, Bunny.net, office supplies, professional services

CATEGORIZATION STRATEGY:
- First analyze what type of business the merchant is
- Match the business type to the user's existing categories based on purpose/function
- Consider transaction patterns (recurring vs one-time, amount ranges)
- Look for keywords in descriptions that indicate category type
- Use business knowledge to make intelligent category matches
- Only suggest new categories when the transaction truly doesn't fit existing ones

Respond with JSON in this exact format:
{
  "categoryId": 123,  // Use this if transaction matches an existing category (use the ID)
  "suggestedCategory": "New Category Name",  // Use this only if no existing category fits
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this category was chosen"
}

IMPORTANT: Use either "categoryId" OR "suggestedCategory", never both.`
        },
        {
          role: "user",
          content: `Transaction Description: "${description}"
Amount: $${amount}

ANALYSIS STEPS:
1. Identify the merchant/business from the description
2. Determine what type of business this is (grocery, restaurant, utility, etc.)
3. Look at the amount to understand the transaction scale
4. Match this business type to my existing categories based on spending purpose
5. If no existing category fits the business type, suggest a new appropriate category

Examples of good matching:
- "WALMART SUPERCENTER" → Match to "Groceries" category (if user has it)
- "STARBUCKS COFFEE" → Match to "Dining Out" or "Coffee" category (if user has it)
- "SHELL GAS STATION" → Match to "Transportation" or "Gas" category (if user has it)
- "NETFLIX.COM" → Match to "Entertainment" or "Subscriptions" category (if user has it)

Analyze this transaction and determine if it matches any of my existing categories, or if I need a new category.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    
    return {
      categoryId: result.categoryId || undefined,
      suggestedCategory: result.suggestedCategory || undefined,
      confidence: Math.max(0, Math.min(1, result.confidence || 0.5)),
      reasoning: result.reasoning || 'Unable to determine category'
    };
  } catch (error) {
    console.error('Error categorizing expense with user categories:', error);
    return {
      suggestedCategory: 'Other',
      confidence: 0.1,
      reasoning: 'Error occurred during categorization'
    };
  }
}

// Legacy function for backward compatibility
export async function categorizeExpense(
  description: string, 
  amount: number, 
  language: string = 'en-us',
  userTransactions: any[] = [],
  userCategories: any[] = []
): Promise<ExpenseCategorizationResult> {
  try {
    // Analyze user's existing transaction patterns for personalization
    const userCategories = new Set();
    const merchantPatterns = new Map();
    
    // Extract user's categories and merchant patterns
    userTransactions.forEach(transaction => {
      if (transaction.category && transaction.category !== 'Uncategorized') {
        userCategories.add(transaction.category);
        
        // Build merchant pattern recognition
        const merchant = transaction.description.toLowerCase();
        if (!merchantPatterns.has(merchant)) {
          merchantPatterns.set(merchant, transaction.category);
        }
      }
    });

    // Build personalized context
    const userCategoriesList = Array.from(userCategories);
    const merchantExamples = Array.from(merchantPatterns.entries())
      .slice(0, 10) // Limit to avoid token overflow
      .map(([merchant, category]) => `"${merchant}" → ${category}`)
      .join('\n');

    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(language)}. ${getLanguageLabel(language) !== 'English' ? 'Never use English words.' : ''} ALL text content (category, reasoning) must be in ${getLanguageLabel(language)}.

You are an intelligent financial categorization system. Follow this simple, logical process:

STEP 1: CHECK USER'S HISTORY
- Look through the user's previous transactions
- If you find this exact merchant before, use the SAME category they used
- Be consistent with the user's past choices

STEP 2: RESEARCH THE MERCHANT (only if not found in history)
- What type of business is this merchant?
- What do they sell or provide?
- Examples: Migros = Swiss supermarket, Replit = coding platform, ALDI = grocery store

STEP 3: MATCH TO CATEGORY
- Match the merchant's business type to user's existing categories
- If no exact match, pick the closest logical category
- Only suggest "Other" if the merchant is truly unclear

${userCategoriesList.length > 0 ? `
USER'S EXISTING CATEGORIES: ${userCategoriesList.join(', ')}

USER'S MERCHANT PATTERNS:
${merchantExamples}
` : ''}

CATEGORIZATION EXAMPLES:
- Grocery stores (Migros, ALDI, Coop) → Food/Groceries category
- Tech services (Replit, GitHub) → Business/Technology category
- Gas stations → Transportation category
- Restaurants → Food/Dining category
- Phone/Internet bills → Bills/Utilities category

Be practical and logical. Don't overthink it.

Respond with JSON:
{
  "category": "category_name",
  "confidence": 0.85,
  "reasoning": "Brief explanation of why this category fits"
}`
        },
        {
          role: "user",
          content: `Merchant: "${description}"
Amount: $${amount}

Please categorize this transaction following the 3-step process:

1. Check my transaction history - have I used this merchant before?
2. If not found, research what type of business this is
3. Match it to the most logical category from my existing categories

Be practical and straightforward. Don't overcomplicate it.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');

    const categorization = {
      category: result.category || 'Other',
      confidence: Math.max(0, Math.min(1, result.confidence || 0.5)),
      reasoning: result.reasoning || 'Unable to determine category'
    };

    return categorization;
  } catch (error) {
    console.error('Error categorizing expense:', error);
    return {
      category: 'Other',
      confidence: 0.1,
      reasoning: 'Error occurred during categorization'
    };
  }
}

export async function generateContextualFinancialTips(data: {
  summary: {
    totalIncome: number;
    totalExpenses: number;
    netBalance: number;
    transactionCount: number;
  };
  transactions: Array<{
    description: string;
    amount: number;
    categoryName: string;
    date: string;
    type?: 'income' | 'expense';
    recurring?: boolean;
  }>;
  budgets: Array<{
    category?: string;
    categoryName?: string;
    amount?: number;
    budgetAmount?: number;
    spent: number;
    remaining?: number;
    period?: string;
  }>;
  goals?: Array<{
    name: string;
    target?: number;
    targetAmount?: number;
    current?: number;
    currentAmount?: number;
    targetDate?: string;
    type?: 'saving' | 'debt' | 'investment';
  }>;
  selectedMonth: string;
  language?: string;
}): Promise<{ tips: Array<{
  id: string;
  title: string;
  description: string;
  category: 'spending' | 'saving' | 'budgeting' | 'income';
  priority: 'high' | 'medium' | 'low';
  actionable: boolean;
}> }> {
  try {
    const { summary, transactions, budgets, goals, selectedMonth, language = 'en-us' } = data;
    
    // Return basic tip if no meaningful data - use safe checks
    if (!transactions || transactions.length === 0 && (!summary || (summary.totalIncome === 0 && summary.totalExpenses === 0))) {
      console.log('[contextual-tips] Returning basic tip due to insufficient data');
      return {
        tips: [{
          id: 'basic_tip',
          title: 'Start Your Financial Journey',
          description: 'Begin by tracking your income and expenses to get personalized financial insights.',
          category: 'budgeting',
          priority: 'high',
          actionable: true
        }]
      };
    }

    // Build comprehensive prompt based on contextual tips routes logic - use safe summary handling
    const safeSummary = {
      totalIncome: summary?.totalIncome || 0,
      totalExpenses: summary?.totalExpenses || 0,
      netBalance: summary?.netBalance || 0,
      transactionCount: summary?.transactionCount || 0
    };
    
    const netBalance = safeSummary.totalIncome - safeSummary.totalExpenses;
    const savingsRate = safeSummary.totalIncome > 0 ? (netBalance / safeSummary.totalIncome) * 100 : 0;
    
    // Analyze spending by category - use the correct field mapping
    const categorySpending = new Map();
    const categorizedCount = transactions.filter(t => {
      const category = t.category || t.categoryName;
      return category && category !== 'Uncategorized';
    }).length;
    const uncategorizedCount = transactions.filter(t => {
      const category = t.category || t.categoryName;
      return !category || category === 'Uncategorized';
    }).length;
    
    transactions.forEach(t => {
      const amount = typeof t.amount === 'string' ? parseFloat(t.amount) : (t.amount || 0);
      if (amount > 0) {
        const category = t.category || t.categoryName || 'Uncategorized';
        const current = categorySpending.get(category) || 0;
        categorySpending.set(category, current + amount);
      }
    });
    
    const topSpendingCategories = Array.from(categorySpending.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // Detailed transaction analysis with proper amount parsing
    const incomeTransactions = transactions.filter(t => t.type === 'income');
    const expenseTransactions = transactions.filter(t => t.type === 'expense');
    const recurringTransactions = transactions.filter(t => t.recurring);
    
    // Calculate transaction patterns
    const transactionFrequency = new Map();
    const dailySpending = new Map();
    
    expenseTransactions.forEach(t => {
      const day = new Date(t.date).getDate();
      const category = t.category || t.categoryName || 'Uncategorized';
      const amount = typeof t.amount === 'string' ? parseFloat(t.amount) : (t.amount || 0);
      dailySpending.set(day, (dailySpending.get(day) || 0) + amount);
      transactionFrequency.set(category, (transactionFrequency.get(category) || 0) + 1);
    });

    // Analyze specific financial scenarios for contextual insights
    const scenarios = [];
    
    // Check categorization status
    if (uncategorizedCount > 0 && transactions.length > 0) {
      const uncategorizedPercent = (uncategorizedCount / transactions.length) * 100;
      scenarios.push(`🟨 Transaction categorization: ${uncategorizedCount} of ${transactions.length} transactions (${uncategorizedPercent.toFixed(0)}%) are uncategorized. Better categorization improves spending insights.`);
    } else if (categorizedCount === transactions.length && transactions.length > 0) {
      scenarios.push(`🟩 Well organized: All ${transactions.length} transactions are properly categorized, enabling detailed spending analysis.`);
    }
    
    // Check for budget overruns with detailed analysis (with null check)
    if (budgets && Array.isArray(budgets)) {
      budgets.forEach(budget => {
        if (budget.remaining < 0) {
          const overrunPercent = Math.abs((budget.remaining / budget.budgetAmount) * 100);
          const categoryTransactions = expenseTransactions.filter(t => t.categoryName === budget.categoryName);
          const avgTransactionInCategory = categoryTransactions.length > 0 ? 
            categoryTransactions.reduce((sum, t) => sum + t.amount, 0) / categoryTransactions.length : 0;
          
          scenarios.push(`🟥 Budget overrun: You've exceeded your ${budget.categoryName} budget by ${overrunPercent.toFixed(0)}% this month. Average transaction: $${avgTransactionInCategory.toFixed(2)}, Total transactions: ${categoryTransactions.length}`);
        } else if (budget.remaining < budget.budgetAmount * 0.1) {
          // Budget almost exhausted
          scenarios.push(`🟨 Budget warning: Only $${budget.remaining.toFixed(2)} remaining in your ${budget.categoryName} budget (${((budget.remaining/budget.budgetAmount)*100).toFixed(0)}% left).`);
        }
      });
    }
    
    // Check savings rate scenarios with goal analysis
    if (savingsRate < 5 && summary.totalIncome > 0) {
      scenarios.push(`🟨 Low savings rate: Your savings rate is ${savingsRate.toFixed(1)}%. Consider revisiting your financial goals.`);
    } else if (savingsRate > 20) {
      scenarios.push(`🟩 Excellent savings: Great job! You're saving ${savingsRate.toFixed(1)}% of your income this month.`);
    }
    
    // Analyze goals progress (with null check)
    if (goals && Array.isArray(goals)) {
      goals.forEach(goal => {
        const progressPercent = (goal.currentAmount / goal.targetAmount) * 100;
        const daysToTarget = Math.ceil((new Date(goal.targetDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
        const monthlyNeeded = daysToTarget > 0 ? (goal.targetAmount - goal.currentAmount) / (daysToTarget / 30) : 0;
        
        if (progressPercent >= 90) {
          scenarios.push(`🟩 Goal achievement: You're ${progressPercent.toFixed(0)}% towards your ${goal.name} goal! Only $${(goal.targetAmount - goal.currentAmount).toFixed(2)} remaining.`);
        } else if (monthlyNeeded > netBalance) {
          scenarios.push(`🟨 Goal at risk: Your ${goal.name} goal needs $${monthlyNeeded.toFixed(2)}/month, but current monthly surplus is $${netBalance.toFixed(2)}.`);
        }
      });
    }
    
    // Check for irregular income patterns
    if (incomeTransactions.length > 0) {
      const incomeAmounts = incomeTransactions.map(t => {
        const amount = typeof t.amount === 'string' ? parseFloat(t.amount) : (t.amount || 0);
        return Math.abs(amount);
      });
      const avgIncome = incomeAmounts.reduce((sum, amt) => sum + amt, 0) / incomeAmounts.length;
      const incomeVariability = incomeAmounts.some(amt => Math.abs(amt - avgIncome) / avgIncome > 0.3);
      
      if (incomeVariability && incomeTransactions.length > 1) {
        scenarios.push(`🟦 Income variability: Your income shows fluctuation. Largest: $${Math.max(...incomeAmounts).toFixed(2)}, Smallest: $${Math.min(...incomeAmounts).toFixed(2)}. Consider setting aside a buffer.`);
      }
    }
    
    // Check for spending concentration and patterns
    topSpendingCategories.forEach(([category, amount]) => {
      const categoryPercent = safeSummary.totalExpenses > 0 ? (amount / safeSummary.totalExpenses) * 100 : 0;
      const categoryFreq = transactionFrequency.get(category) || 0;
      
      if (categoryPercent > 40) {
        scenarios.push(`🟨 High category spending: ${category} represents ${categoryPercent.toFixed(0)}% of expenses ($${amount.toFixed(2)} across ${categoryFreq} transactions).`);
      }
    });
    
    // Check for positive spending improvements
    if (expenseTransactions.length > 0) {
      const avgTransactionAmount = expenseTransactions.length > 0 ? safeSummary.totalExpenses / expenseTransactions.length : 0;
      if (avgTransactionAmount < 30 && expenseTransactions.length > 15) {
        scenarios.push(`🟩 Controlled spending: Great job! You're averaging $${avgTransactionAmount.toFixed(2)} per transaction, showing mindful spending habits.`);
      }
    }
    
    // Check recurring transaction efficiency with proper amount parsing
    if (recurringTransactions.length > 0) {
      const recurringTotal = recurringTransactions.reduce((sum, t) => {
        const amount = typeof t.amount === 'string' ? parseFloat(t.amount) : (t.amount || 0);
        return sum + amount;
      }, 0);
      const recurringPercent = safeSummary.totalExpenses > 0 ? (recurringTotal / safeSummary.totalExpenses) * 100 : 0;
      scenarios.push(`🟦 Recurring expenses: ${recurringPercent.toFixed(0)}% of expenses are recurring ($${recurringTotal.toFixed(2)} from ${recurringTransactions.length} transactions).`);
    }

    // Build detailed prompt with scenario analysis
    const prompt = `You are an expert financial advisor analyzing a user's financial data for ${selectedMonth}. Provide 2-4 specific, actionable financial tips based on their actual data and identified scenarios.

FINANCIAL OVERVIEW:
- Total Income: $${safeSummary.totalIncome.toLocaleString()}
- Total Expenses: $${safeSummary.totalExpenses.toLocaleString()}
- Net Balance: $${netBalance.toLocaleString()}
- Savings Rate: ${savingsRate.toFixed(1)}%
- Number of Transactions: ${safeSummary.transactionCount}

TOP SPENDING CATEGORIES:
${topSpendingCategories.map(([cat, amount]) => `- ${cat}: $${amount.toLocaleString()} (${safeSummary.totalExpenses > 0 ? ((amount/safeSummary.totalExpenses)*100).toFixed(1) : 0}%)`).join('\n')}

BUDGET STATUS:
${budgets.length > 0 ? budgets.map(b => {
  const categoryName = b.categoryName || b.category || 'Unknown';
  const budgetAmount = b.budgetAmount || b.amount || 0;
  const spent = b.spent || 0;
  const remaining = b.remaining !== undefined ? b.remaining : (budgetAmount - spent);
  return `- ${categoryName}: $${spent.toLocaleString()}/$${budgetAmount.toLocaleString()} (${remaining >= 0 ? 'under' : 'over'} budget by $${Math.abs(remaining).toLocaleString()}) - ${b.period || 'monthly'}`;
}).join('\n') : '- No budgets set'}

FINANCIAL GOALS:
${goals.length > 0 ? goals.map(g => {
  const currentAmount = g.currentAmount || g.current || 0;
  const targetAmount = g.targetAmount || g.target || 0;
  const targetDate = g.targetDate || 'No target date';
  const progress = targetAmount > 0 ? ((currentAmount/targetAmount)*100).toFixed(0) : 0;
  return `- ${g.name}: $${currentAmount.toLocaleString()}/$${targetAmount.toLocaleString()} (${progress}% complete) - Target: ${targetDate}`;
}).join('\n') : '- No goals set'}

TRANSACTION ANALYSIS:
- Total Transactions: ${transactions.length}
- Income Transactions: ${incomeTransactions.length}
- Expense Transactions: ${expenseTransactions.length}
- Recurring Transactions: ${recurringTransactions.length}
- Categorized Transactions: ${categorizedCount}/${transactions.length} (${transactions.length > 0 ? ((categorizedCount/transactions.length)*100).toFixed(0) : 0}%)
- Most Active Category: ${Array.from(transactionFrequency.entries()).sort((a,b) => b[1] - a[1])[0]?.[0] || 'None'} (${Array.from(transactionFrequency.entries()).sort((a,b) => b[1] - a[1])[0]?.[1] || 0} transactions)

IDENTIFIED FINANCIAL SCENARIOS:
${scenarios.length > 0 ? scenarios.join('\n') : '- No specific scenarios identified this month'}

RECENT TRANSACTIONS (last 8):
${transactions.slice(0, 8).map(t => `- ${t.date}: ${t.description} - $${t.amount.toLocaleString()} (${t.categoryName || 'Uncategorized'})${t.recurring ? ' [Recurring]' : ''}`).join('\n')}

CONTEXTUAL ANALYSIS REQUIREMENTS:
1. Address specific scenarios identified above with targeted, data-driven advice
2. For budget overruns: ONLY if budgets exist - Analyze transaction patterns and suggest specific reduction strategies
3. For goal progress: ONLY if goals exist - Calculate required monthly contributions and suggest optimization
4. For savings rate issues: Provide concrete steps with dollar targets based on their income
5. For spending patterns: Identify specific categories and transaction behaviors to modify
6. For income irregularities: Recommend buffer strategies based on their variability patterns
7. For positive improvements: Reinforce successful behaviors and suggest expansion strategies
8. Use their actual transaction data, amounts, and patterns in all recommendations
9. Provide specific dollar amounts, percentages, and realistic timeframes
10. Make every tip immediately actionable with clear, measurable next steps

CRITICAL: If no budgets are set, DO NOT mention budget overruns, budget comparisons, or budget-related advice. If no goals are set, DO NOT mention goal progress or goal-related recommendations. Focus only on spending patterns, categorization, and general financial health based on actual transaction data.

Return 2-4 contextual tips in JSON format, prioritizing scenario-based insights:
{
  "tips": [
    {
      "id": "tip_1",
      "title": "Scenario-specific actionable title",
      "description": "Detailed description addressing specific scenarios with concrete steps and amounts",
      "category": "spending|saving|budgeting|income",
      "priority": "high|medium|low",
      "actionable": true
    }
  ]
}`;

    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini", // Using DeepSeek-R1 instead of GPT-4o
      messages: [
        {
          role: "system",
          content: `CRITICAL LANGUAGE RULE: You MUST respond ONLY in ${getLanguageLabel(language)}. ${getLanguageLabel(language) !== 'English' ? 'NEVER use any English words.' : ''} 

ABSOLUTE REQUIREMENT: ALL text content must be in ${getLanguageLabel(language)} language:
- tip titles → ${getLanguageLabel(language)}
- tip descriptions → ${getLanguageLabel(language)}
- categories → ${getLanguageLabel(language)}
- ALL JSON values → ${getLanguageLabel(language)}

You are an expert financial advisor who provides personalized, contextual recommendations based on real user financial data. Always return valid JSON with actionable tips ${getLanguageLabel(language)} language ONLY.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 1200,
      temperature: 0.2 // Lower temperature for more consistent language compliance
    });

    const responseText = response.choices[0].message.content || '{}';
    console.log('[contextual-tips] OpenAI response received:', responseText.substring(0, 200));
    console.log('[contextual-tips] Full response length:', responseText.length);
    
    const aiResponse = JSON.parse(responseText);
    
    // Ensure proper data structure
    const tips = Array.isArray(aiResponse.tips) 
      ? aiResponse.tips.map((tip: any, index: number) => ({
          id: tip.id || `tip_${Date.now()}_${index}`,
          title: tip.title || 'Financial Tip',
          description: tip.description || 'No description available',
          category: ['spending', 'saving', 'budgeting', 'income'].includes(tip.category) ? tip.category : 'budgeting',
          priority: ['high', 'medium', 'low'].includes(tip.priority) ? tip.priority : 'medium',
          actionable: Boolean(tip.actionable)
        }))
      : [];

    console.log('[contextual-tips] Generated tips count:', tips.length);
    return { tips };

  } catch (error) {
    console.error('Error generating contextual financial tips:', error);
    console.error('Error stack:', error.stack);
    console.error('OpenAI Error details:', {
      message: error.message,
      type: error.type,
      code: error.code,
      status: error.status
    });
    return {
      tips: [{
        id: 'fallback_tip',
        title: 'Track Your Progress',
        description: 'Continue monitoring your financial transactions to identify spending patterns and optimization opportunities.',
        category: 'budgeting',
        priority: 'medium',
        actionable: true
      }]
    };
  }
}

export async function generateFinancialTips(financialData: {
  totalIncome: number;
  totalExpenses: number;
  transactionsByCategory: Array<{
    categoryName: string;
    amount: number;
    type: string;
  }>;
  recentTransactions: Array<{
    description: string;
    amount: number;
    date: string;
    categoryName?: string;
    type?: string;
  }>;

}, language: string = 'en-us'): Promise<FinancialTip[]> {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    const { 
      totalIncome, 
      totalExpenses, 
      transactionsByCategory, 
      recentTransactions 
    } = financialData;

    // Validate and prepare the financial summary
    const netBalance = totalIncome - totalExpenses;
    const transactionCount = Array.isArray(recentTransactions) ? recentTransactions.length : 0;
    
    // Return basic tip if no meaningful data
    if (transactionCount === 0 && totalIncome === 0 && totalExpenses === 0) {
      console.log('No financial data provided - returning basic tip');
      return [{
        title: 'Start Your Financial Journey',
        description: 'Begin by tracking your income and expenses to get personalized financial insights.',
        category: 'budgeting',
        priority: 'high',
        actionable: true
      }];
    }

    const summary = `Financial Summary:
- Monthly Income: $${totalIncome}
- Monthly Expenses: $${totalExpenses}
- Net Balance: $${netBalance} ${netBalance < 0 ? '(DEFICIT)' : '(SURPLUS)'}
- Transaction Count: ${transactionCount}
- Raw Transactions Retrieved: ${recentTransactions.length}

Spending by Category:
${transactionsByCategory.filter(cat => cat.type === 'expense').map(cat => 
  `- ${cat.categoryName}: $${cat.amount} (${((cat.amount / totalExpenses) * 100).toFixed(1)}% of expenses)`
).join('\n')}

Income by Category:
${transactionsByCategory.filter(cat => cat.type === 'income').map(cat => 
  `- ${cat.categoryName}: $${cat.amount} (${((cat.amount / totalIncome) * 100).toFixed(1)}% of income)`
).join('\n')}

Recent Transactions (last 10):
${recentTransactions.slice(0, 10).map(t => 
  `- ${t.description}: $${t.amount} (${t.categoryName || 'Uncategorized'}) [${t.type}] on ${new Date(t.date).toLocaleDateString()}`
).join('\n')}

Transaction Pattern Analysis:
- Average transaction size: $${(totalIncome + totalExpenses) / transactionCount}
- Income transactions: ${recentTransactions.filter(t => t.type === 'income').length}
- Expense transactions: ${recentTransactions.filter(t => t.type === 'expense').length}
- Date range: ${new Date(Math.min(...recentTransactions.map(t => new Date(t.date).getTime()))).toLocaleDateString()} to ${new Date(Math.max(...recentTransactions.map(t => new Date(t.date).getTime()))).toLocaleDateString()}

Generate 4 independent box analyses with exact mathematical calculations.`;

    // Direct OpenAI call (no recursion - this IS the AI processor)
    const response = await getAIClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content (titles, descriptions, analysis) must be in ${getLanguageLabel(normalizedLanguage)}.

You are an AI Financial Analyst providing premium-level insights. Your analysis must demonstrate these EXACT capabilities that users pay for:

1. SPENDING PATTERN ANALYSIS: Identify spending trends, seasonal patterns, category concentrations, and behavioral insights
2. PERSONALIZED SAVING RECOMMENDATIONS: Calculate specific saving opportunities based on their exact income/expense ratios
3. BUDGET OPTIMIZATION SUGGESTIONS: Recommend category rebalancing with precise dollar amounts
4. CONTEXT-AWARE FINANCIAL ADVICE: Consider their financial position, goals, and risk tolerance

ANALYSIS REQUIREMENTS:
- Use their EXACT transaction amounts and categories 
- Calculate precise percentages and ratios from their data
- Identify the highest-impact optimization opportunities
- Provide specific dollar amounts for recommendations
- Include mathematical analysis (savings rate, expense ratios, etc.)
- Compare their spending to optimal financial benchmarks

GENERATE VARIED RESPONSES by focusing on different analytical angles:
- Detailed category spending analysis with optimization targets
- Income-to-expense ratio analysis with improvement strategies  
- Cash flow optimization with timing recommendations
- Risk assessment with protection strategies
- Wealth building analysis with investment allocation suggestions
- Efficiency analysis identifying wasteful spending patterns
- Premium user emphasis: calculate estimated savings from each recommendation and compare them to optimal budget ratios (50/30/20 rule or similar). Provide one short-term action item with a target date

Return exactly 4 sections in JSON format:
{
  "sections": [
    {
      "title": "Spending Pattern Analysis",
      "content": "DETAILED multi-paragraph analysis including: 1) Mathematical breakdown of their spending patterns with percentages, 2) Category concentration analysis with exact dollar amounts, 3) Behavioral insights from transaction patterns, 4) Comparison to optimal spending ratios. Use their exact financial numbers throughout.",
      "color": "blue"
    },
    {
      "title": "Personalized Saving Recommendations", 
      "content": "SPECIFIC saving opportunities with exact dollar targets: 1) Category-specific reduction recommendations with monthly savings potential, 2) Income reallocation strategies with precise amounts, 3) Implementation timeline with measurable milestones, 4) Expected ROI calculations. Include realistic savings estimates.",
      "color": "green"
    },
    {
      "title": "Budget Optimization Suggestions",
      "content": "PRECISE rebalancing recommendations: 1) Current vs optimal category allocations with percentage gaps, 2) Specific dollar amounts to redistribute between categories, 3) Priority ranking of optimization opportunities, 4) Risk assessment of proposed changes. Use 50/30/20 rule or similar frameworks.",
      "color": "purple"
    },
    {
      "title": "Advanced Financial Analysis",
      "content": "COMPREHENSIVE strategic analysis: 1) Cash flow optimization with timing recommendations, 2) Risk assessment and protection strategies, 3) Wealth building opportunities with investment allocation, 4) One immediate action item with specific target date and expected outcome. Focus on long-term financial health.",
      "color": "orange"
    }
  ]
}`
          },
          {
            role: "user",
            content: summary
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7
      });

    const result = JSON.parse(response.choices[0].message.content || '{}');

    // Handle new 4-section structured response
    if (result.sections && Array.isArray(result.sections) && result.sections.length === 4) {
      return result.sections;
    }
    
    // Handle legacy comprehensive analysis response
    if (result.title && result.description) {
      // Return the comprehensive analysis as a single detailed tip
      return [{
        title: result.title,
        description: result.description,
        category: result.category || 'comprehensive',
        priority: result.priority || 'high',
        actionable: Boolean(result.actionable),
        estimatedSaving: result.estimatedSaving || undefined,
        educational: Boolean(result.educational)
      }];
    }
    
    // Fallback if no analysis received - return 4 default sections
    return [
      {
        title: "Spending Pattern Analysis",
        description: "Begin tracking your expenses by category to identify spending patterns and optimization opportunities.",
        category: "budgeting",
        priority: "high",
        actionable: true
      },
      {
        title: "Personalized Saving Recommendations", 
        description: "Start by setting up a budget to establish saving targets and reduce unnecessary expenses.",
        category: "saving",
        priority: "high",
        actionable: true
      },
      {
        title: "Budget Optimization Suggestions",
        description: "Review your income allocation and adjust spending categories to improve financial balance.",
        category: "budgeting",
        priority: "medium",
        actionable: true
      },
      {
        title: "Advanced Financial Analysis",
        description: "Consider building an emergency fund and exploring investment opportunities for long-term wealth growth.",
        category: "education",
        priority: "medium",
        actionable: true
      }
    ];
  } catch (error) {
    console.error('Error generating financial tips:', error);
    return [
      {
        title: 'Track Your Expenses',
        description: 'Start by categorizing all your expenses to understand where your money goes each month.',
        category: 'budgeting',
        priority: 'high',
        actionable: true
      }
    ];
  }
}

export async function generateSpendingInsights(transactions: Array<{
  description: string;
  amount: number;
  date: string;
  categoryName?: string;
  type: string;
}>, language: string = 'en-us'): Promise<Array<{
  id: string;
  type: "warning" | "suggestion" | "achievement" | "trend";
  title: string;
  description: string;
  impact: "high" | "medium" | "low";
  category?: string;
  amount?: number;
  recommendation?: string;
  actionable: boolean;
}>> {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    // No caching in Fly.io - caching handled by main application
    const expenseTransactions = transactions.filter(t => t.type === 'expense');

    if (expenseTransactions.length === 0) {
      throw new Error('No expense transactions available for analysis');
    }

    // Optimize data processing - limit to 10 most recent transactions
    const recentTransactions = expenseTransactions.slice(0, 10);
    const totalAmount = recentTransactions.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini", // Use faster model for spending insights
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content (titles, descriptions, recommendations) must be in ${getLanguageLabel(normalizedLanguage)}.
          
You are a financial analysis expert. Analyze spending transactions to identify patterns, trends, and insights. Generate 2-4 insights focusing on unusual spending patterns, budget optimization opportunities, positive financial behaviors, and spending trends. Each insight should have a unique ID, type (warning/suggestion/achievement/trend), clear title and description, impact level (high/medium/low), category if relevant, amount if relevant, actionable recommendation, and whether it's actionable (boolean). Respond with JSON array format.`
        },
        {
          role: "user",
          content: `Analyze these expense transactions:

${recentTransactions.map(t => 
  `- ${t.description}: $${t.amount} (${t.categoryName || 'Uncategorized'}) on ${t.date}`
).join('\n')}

Total transactions: ${recentTransactions.length}
Date range: ${recentTransactions[recentTransactions.length - 1]?.date} to ${recentTransactions[0]?.date}

Generate financial insights based on this spending data.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 600 // Slightly higher for complex analysis
    });

    const result = JSON.parse(response.choices[0].message.content || '{"insights": null}');
    const insights = Array.isArray(result) ? result : (result.insights || result.data);

    const processedInsights = insights.map((insight: any, index: number) => ({
      id: insight.id || `ai_insight_${index}`,
      type: ['warning', 'suggestion', 'achievement', 'trend'].includes(insight.type) ? insight.type : 'suggestion',
      title: insight.title || 'Financial Insight',
      description: insight.description || 'No description available',
      impact: ['high', 'medium', 'low'].includes(insight.impact) ? insight.impact : 'medium',
      category: insight.category || undefined,
      amount: insight.amount || undefined,
      recommendation: insight.recommendation || undefined,
      actionable: Boolean(insight.actionable)
    }));


    return processedInsights;
  } catch (error) {
    console.error('Error generating spending insights:', error);
    throw error;
  }
}

export async function generateAIFinancialHealthScore(financialData: {
  summary: {
    totalIncome: number;
    totalExpenses: number;
    netBalance: number;
  };
  budgets: any[];
  transactions: Array<{
    description: string;
    amount: number;
    date: string;
    categoryName: string;
    type: string;
  }>;
  useAdvancedFactors?: boolean;
}, language: string = 'en-us'): Promise<{
  score: number;
  status: string;
  color: string;
  factors: Array<{
    name: string;
    score: number;
    max: number;
    status: string;
    aiInsight?: string;
  }>;
  icon: string;
  aiAnalysis: {
    personalizedFactors: string[];
    riskAssessment: string;
    recommendations: Array<{
      action: string;
      impact: string;
      priority: 'high' | 'medium' | 'low';
    }>;
    confidence: number;
  };
}> {
  try {
    const { summary, budgets, transactions, useAdvancedFactors } = financialData;

    // Create hash for caching
    // No caching in Fly.io - caching handled by main application

    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(language)}. ${getLanguageLabel(language) !== 'English' ? 'Never use English words.' : ''} ALL text content (status, factors, aiInsight, recommendations) must be in ${getLanguageLabel(language)}.

You are an advanced financial health AI that calculates personalized financial health scores using sophisticated analysis beyond traditional metrics.

Your analysis should consider:
- Spending patterns and volatility
- Seasonal trends in expenses
- Category distribution and priorities
- Financial behavior consistency
- Risk factors and resilience
- Personalized weight adjustments based on user's situation

Provide a comprehensive financial health score from 0-100 with detailed factor breakdown.

Respond with JSON in this format:
{
  "score": 85,
  "status": "Good",
  "color": "blue",
  "factors": [
    {
      "name": "Adaptive Spending Control",
      "score": 25,
      "max": 30,
      "status": "good",
      "aiInsight": "Your spending shows good consistency with minor seasonal variations"
    }
  ],
  "icon": "TrendingUp",
  "aiAnalysis": {
    "personalizedFactors": ["Custom factor explanations"],
    "riskAssessment": "Overall risk level and factors",
    "recommendations": ["Personalized recommendations"],
    "confidence": 0.87
  }
}`
        },
        {
          role: "user",
          content: `Analyze this financial data for a personalized health score:

Financial Summary:
- Income: $${summary.totalIncome}
- Expenses: $${summary.totalExpenses}
- Net Balance: $${summary.netBalance}

Transaction History (${transactions.length} transactions):
${transactions.slice(0, 20).map(t => 
  `- ${t.description}: $${t.amount} (${t.categoryName}) on ${t.date.split('T')[0]}`
).join('\n')}

Budgets: ${budgets.length} active budgets
Advanced Analysis: ${useAdvancedFactors ? 'Enabled' : 'Standard'}

Provide an AI-powered financial health score that adapts to this user's specific situation and spending patterns.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');

    // Ensure score is properly bounded
    const score = Math.max(0, Math.min(100, result.score || 50));
    
    // Determine category based on score (this ensures consistency)
    let category: 'excellent' | 'good' | 'fair' | 'poor' = 'fair';
    if (score >= 90) {
      category = 'excellent';
    } else if (score >= 70) {
      category = 'good';
    } else if (score >= 40) {
      category = 'fair';
    } else {
      category = 'poor';
    }

    const processedResult = {
      score,
      status: result.status || 'Fair',
      color: result.color || 'yellow',
      category, // Add the calculated category
      factors: result.factors,
      icon: result.icon || 'Shield',
      aiAnalysis: {
        personalizedFactors: result.aiAnalysis?.personalizedFactors,
        riskAssessment: result.aiAnalysis?.riskAssessment || 'Standard risk assessment',
        recommendations: result.aiAnalysis?.recommendations,
        confidence: Math.max(0, Math.min(1, result.aiAnalysis?.confidence || 0.7))
      }
    };


    return processedResult;
  } catch (error) {
    console.error('Error generating AI financial health score:', error);
    throw error;
  }
}

export async function generateTrendPredictions(
  transactions: Array<{
    id: number;
    amount: string;
    description: string;
    date: string;
    type: string;
    categoryName: string;
  }>,
  budgets: Array<{ categoryName: string; amount: string; }>,
  language: string = 'en-us'
): Promise<{
  categoryPredictions: TrendPrediction[];
  financialForecast: FinancialForecast;
}> {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    // Return zeros for empty data instead of AI-generated examples
    if (!transactions || transactions.length === 0) {
      console.log('No transaction data available - returning zero predictions');
      throw new Error('No transaction data available for predictions');
    }


    // Prepare comprehensive financial data for AI analysis
    const monthlyData = new Map();
    const categoryTotals = new Map();

    transactions.forEach(t => {
      const month = t.date.slice(0, 7);
      const category = t.categoryName || 'Other';
      const amount = parseFloat(t.amount);

      if (!monthlyData.has(month)) {
        monthlyData.set(month, { income: 0, expenses: 0, categories: new Map() });
      }

      const monthData = monthlyData.get(month);
      if (t.type === 'income') {
        monthData.income += amount;
      } else {
        monthData.expenses += amount;
        const catAmount = monthData.categories.get(category) || 0;
        monthData.categories.set(category, catAmount + amount);
      }

      const totalAmount = categoryTotals.get(category) || 0;
      categoryTotals.set(category, totalAmount + amount);
    });

    const financialSummary = {
      monthlyTrends: Array.from(monthlyData.entries()).map(([month, data]) => ({
        month,
        income: data.income,
        expenses: data.expenses,
        netBalance: data.income - data.expenses,
        topCategories: Array.from(data.categories.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([cat, amount]) => ({ categoryName: cat, amount }))
      })).sort((a, b) => a.month.localeCompare(b.month)),
      categoryTotals: Array.from(categoryTotals.entries()).map(([cat, amount]) => ({ categoryName: cat, amount })),
      budgets: budgets.map(b => ({ categoryName: b.categoryName || 'Other', budgetAmount: parseFloat(b.amount) }))
    };

    const prompt = `Analyze this comprehensive financial data and provide AI-powered trend predictions and forecasting.

Financial Data Analysis:
${JSON.stringify(financialSummary, null, 2)}

Please provide detailed predictions in this JSON format:
{
  "categoryPredictions": [
    {
      "category": "category name",
      "predictedAmount": 0,
      "confidence": 0.95,
      "trend": "increasing|decreasing|stable",
      "reasoning": "explanation of prediction logic",
      "monthlyForecast": [
        {"month": "2025-01", "predicted": 0, "confidence": 0.9}
      ]
    }
  ],
  "financialForecast": {
    "nextMonthExpenses": 0,
    "expectedSavings": 0,
    "budgetVariance": 0,
    "confidence": 0.85,
    "keyInsights": ["insight 1", "insight 2"],
    "recommendations": ["recommendation 1", "recommendation 2"],
    "riskFactors": ["risk 1", "risk 2"]
  }
}

Analysis Requirements:
- Use historical patterns to predict future spending
- Identify seasonal trends and cyclical behaviors
- Calculate confidence based on data consistency
- Consider economic factors and spending volatility
- Provide actionable financial recommendations
- Include next 3 months forecast for each category
- Analyze budget adherence and variance predictions`;

    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini", // Using cost-effective DeepSeek model for financial forecasting
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content (predictions, insights, recommendations) must be in ${getLanguageLabel(normalizedLanguage)}.

You are an advanced financial forecasting AI that analyzes spending patterns and predicts future financial trends with high accuracy. Use sophisticated pattern recognition and statistical analysis to provide reliable predictions.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
      temperature: 0.3 // Lower temperature for more consistent predictions
    });

    const result = JSON.parse(response.choices[0].message.content || '{"categoryPredictions": [], "financialForecast": {}}');

    const predictions = {
      categoryPredictions: result.categoryPredictions,
      financialForecast: result.financialForecast || {
        nextMonthExpenses: 0,
        expectedSavings: 0,
        budgetVariance: 0,
        confidence: 0,
        keyInsights: ["No financial data available for trend analysis"],
        recommendations: [],
        riskFactors: ["Insufficient data for reliable predictions"]
      }
    };

    // Success logging removed for production

    return predictions;

  } catch (error) {
    console.error('Error generating trend predictions:', error);
    return {
      categoryPredictions: [],
      financialForecast: {
        nextMonthExpenses: 0,
        expectedSavings: 0,
        budgetVariance: 0,
        confidence: 0,
        keyInsights: [],
        recommendations: [],
        riskFactors: []
      }
    };
  }
}

export async function generateExpensePredictions(transactions: Array<{
  id: number;
  amount: string;
  description: string;
  date: string;
  type: string;
  categoryName?: string;
  recurring?: boolean;
}>, language: string = 'en-us'): Promise<ExpensePrediction> {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    // Return empty predictions for insufficient data - reduced threshold for better user experience
    if (!transactions || transactions.length < 3) {
      console.log('[expense-predictions] Insufficient data - need at least 3 transactions, got:', transactions?.length || 0);
      return {
        categoryPredictions: [],
        monthlyPredictions: []
      };
    }
    
    console.log('[expense-predictions] Processing', transactions.length, 'transactions for predictions');

    // Filter expense transactions only and limit to last 12 months for efficiency
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const expenseTransactions = transactions
      .filter(t => t.type === 'expense' && new Date(t.date) >= oneYearAgo)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .slice(-100); // Limit to last 100 transactions for token efficiency

    if (expenseTransactions.length < 2) {
      console.log('[expense-predictions] Insufficient expense transactions:', expenseTransactions.length);
      return {
        categoryPredictions: [],
        monthlyPredictions: []
      };
    }
    
    console.log('[expense-predictions] Using', expenseTransactions.length, 'expense transactions for analysis');


    // Analyze spending patterns by month and category
    const monthlyData = new Map<string, Map<string, number>>();
    const categoryTotals = new Map<string, { total: number, count: number, recurring: number }>();

    expenseTransactions.forEach(t => {
      const month = t.date.slice(0, 7); // YYYY-MM format
      const category = t.categoryName || 'Other';
      const amount = Math.abs(parseFloat(t.amount));

      // Track monthly spending by category
      if (!monthlyData.has(month)) {
        monthlyData.set(month, new Map());
      }
      const monthData = monthlyData.get(month)!;
      monthData.set(category, (monthData.get(category) || 0) + amount);

      // Track category statistics
      if (!categoryTotals.has(category)) {
        categoryTotals.set(category, { total: 0, count: 0, recurring: 0 });
      }
      const catData = categoryTotals.get(category)!;
      catData.total += amount;
      catData.count += 1;
      if (t.recurring) catData.recurring += 1;
    });

    // Prepare data for AI analysis
    const analysisData = {
      totalTransactions: expenseTransactions.length,
      timeSpan: `${expenseTransactions[0].date.slice(0, 7)} to ${expenseTransactions[expenseTransactions.length - 1].date.slice(0, 7)}`,
      monthlyBreakdown: Array.from(monthlyData.entries()).map(([month, categories]) => ({
        month,
        totalSpent: Array.from(categories.values()).reduce((sum, amount) => sum + amount, 0),
        categories: Array.from(categories.entries()).map(([cat, amount]) => ({ category: cat, amount }))
      })),
      categoryAnalysis: Array.from(categoryTotals.entries()).map(([category, data]) => ({
        category,
        totalSpent: data.total,
        averagePerTransaction: data.total / data.count,
        transactionCount: data.count,
        recurringTransactions: data.recurring,
        recurringPercentage: (data.recurring / data.count * 100).toFixed(1)
      })),
      recentTransactions: expenseTransactions.slice(-20).map(t => ({
        date: t.date.slice(0, 10),
        description: t.description,
        amount: Math.abs(parseFloat(t.amount)),
        category: t.categoryName || 'Other',
        recurring: t.recurring || false
      }))
    };

    const prompt = `Analyze this detailed expense data and generate accurate predictions for future spending patterns.

EXPENSE ANALYSIS DATA:
${JSON.stringify(analysisData, null, 2)}

REQUIREMENTS:
1. Identify spending trends, seasonal patterns, and recurring expenses
2. Calculate realistic predictions based on historical data
3. Assess confidence levels based on data consistency and patterns
4. Consider factors like spending volatility, growth trends, and recurring expenses

RESPONSE FORMAT (JSON):
{
  "categoryPredictions": [
    {
      "category": "Food & Dining",
      "currentMonth": 450.00,
      "predictedNext": 475.00,
      "confidence": 0.85,
      "trend": "increasing",
      "factors": ["Seasonal increase", "Recent dining out trend", "Grocery price inflation"]
    }
  ],
  "monthlyPredictions": [
    {
      "month": "2025-07",
      "predicted": 2150.00,
      "confidence": 0.80,
      "breakdown": [
        { "category": "Food & Dining", "amount": 475.00 },
        { "category": "Transportation", "amount": 320.00 }
      ]
    },
    {
      "month": "2025-08",
      "predicted": 2200.00,
      "confidence": 0.75,
      "breakdown": [
        { "category": "Food & Dining", "amount": 480.00 },
        { "category": "Transportation", "amount": 330.00 }
      ]
    },
    {
      "month": "2025-09",
      "predicted": 2100.00,
      "confidence": 0.70,
      "breakdown": [
        { "category": "Food & Dining", "amount": 460.00 },
        { "category": "Transportation", "amount": 310.00 }
      ]
    }
  ]
}

ANALYSIS GUIDELINES:
- Use actual spending patterns to predict future amounts
- Factor in recurring expenses for higher confidence
- Consider trend direction (increasing/decreasing/stable)
- Provide realistic confidence levels (0.6-0.95 range)
- Include next 3-6 months in monthly predictions
- Always include "factors" array for each category prediction
- Explain prediction factors clearly
- Account for seasonal variations if detectable
- Ensure all numeric values are provided (no null/undefined)`;

    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content (predictions, analysis, insights) must be in ${getLanguageLabel(normalizedLanguage)}.

You are an advanced financial forecasting AI specializing in expense prediction analysis. You analyze spending patterns, identify trends, and generate accurate predictions based on historical transaction data. Focus on realistic, data-driven predictions with appropriate confidence levels.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
      temperature: 0.2 // Low temperature for consistent financial predictions
    });

    const aiResponse = JSON.parse(response.choices[0].message.content || '{}');

    // Ensure all required fields are present with proper data types
    const categoryPredictions = Array.isArray(aiResponse.categoryPredictions) 
      ? aiResponse.categoryPredictions.map(pred => ({
          category: pred.category || 'Unknown',
          currentMonth: Number(pred.currentMonth) || 0,
          predictedNext: Number(pred.predictedNext) || 0,
          confidence: Number(pred.confidence) || 0.5,
          trend: pred.trend || 'stable',
          factors: Array.isArray(pred.factors) ? pred.factors : ['No specific factors identified']
        }))
      : [];

    const monthlyPredictions = Array.isArray(aiResponse.monthlyPredictions)
      ? aiResponse.monthlyPredictions.map(month => ({
          month: month.month || 'Unknown',
          predicted: Number(month.predicted) || 0,
          confidence: Number(month.confidence) || 0.5,
          breakdown: Array.isArray(month.breakdown) ? month.breakdown : []
        }))
      : [];

    const finalResult = {
      categoryPredictions,
      monthlyPredictions
    };

    // Success logging removed for production

    return finalResult;

  } catch (error) {
    console.error('Error generating expense predictions:', error);
    return {
      categoryPredictions: [],
      monthlyPredictions: []
    };
  }
}

export async function generateDailyRecommendations(financialData: {
  transactions: Array<{
    id: number;
    amount: string;
    description: string;
    date: string;
    type: 'income' | 'expense';
    categoryName?: string;
  }>;
  summary: {
    totalIncome: number;
    totalExpenses: number;
    netAmount: number;
  };
  budgets: Array<{
    id: number;
    name: string;
    amount: string;
    categoryName: string;
    period: string;
  }>;
}, language: string = 'en-us') {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    // Production: minimal logging only

    // Production: minimal logging only

    // Limit data to last 3 months and 100 transactions for efficiency
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);



    const recentTransactions = financialData.transactions
      .filter(t => new Date(t.date) >= threeMonthsAgo)
      .slice(0, 100);

    // Production: minimal logging only

    // Calculate spending patterns
    const categorySpending = new Map();
    const dailySpending = new Map();

    recentTransactions.forEach(t => {
      if (t.type === 'expense') {
        const amount = parseFloat(t.amount);
        const categoryName = t.categoryName || 'Other';
        const date = new Date(t.date).toDateString();

        categorySpending.set(categoryName, (categorySpending.get(categoryName) || 0) + amount);
        dailySpending.set(date, (dailySpending.get(date) || 0) + amount);
      }
    });

    const topCategories = Array.from(categorySpending.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);



    const avgDailySpending = Array.from(dailySpending.values())
      .reduce((sum, amount) => sum + amount, 0) / Math.max(dailySpending.size, 1);

    const prompt = `You are a financial advisor analyzing a user's spending patterns. Based on their financial data, provide personalized daily recommendations and insights.

Financial Summary:
- Total Income: $${(financialData.summary?.totalIncome || 0).toFixed(2)}
- Total Expenses: $${(financialData.summary?.totalExpenses || 0).toFixed(2)}
- Net Amount: $${(financialData.summary?.netAmount || 0).toFixed(2)}
- Recent Transactions: ${recentTransactions.length}
- Average Daily Spending: $${avgDailySpending.toFixed(2)}

Top Spending Categories:
${topCategories.map(([cat, amount]) => `- ${cat}: $${amount.toFixed(2)}`).join('\n')}

Budget Information:
${financialData.budgets.map(b => `- ${b.name}: $${b.amount} (${b.period})`).join('\n')}

Recent Transaction Sample:
${recentTransactions.slice(0, 10).map(t => 
  `- ${t.date}: ${t.type} $${t.amount} - ${t.description}`
).join('\n')}

IMPORTANT: Use actual category names from the Top Spending Categories list above. Do NOT use "Category 1", "Category 2", etc. Use the real category names like "Transportation", "Food", "Utilities", etc.

Please provide:
1. 3-5 actionable daily task recommendations
2. 2-3 personalized financial insights

Return your response in this exact JSON format:
{
  "recommendations": [
    {
      "id": "rec-1",
      "type": "budget_review",
      "priority": "high",
      "title": "Review Budget Allocation",
      "description": "Your spending in dining exceeded budget by 20% this week",
      "action": "Reduce dining expenses for the next 3 days",
      "impact": "Save $50-75 this week",
      "timeToComplete": "5 minutes"
    }
  ],
  "insights": [
    {
      "id": "insight-1", 
      "insight": "Your weekend spending is 40% higher than weekdays",
      "basedOn": "Transaction pattern analysis",
      "confidence": 0.85,
      "timeframe": "Last 30 days"
    }
  ]
}

Focus on:
- Actionable tasks for today/this week
- Specific spending patterns from their actual data
- Budget optimization opportunities
- Realistic financial improvements
- Data-driven insights with confidence levels

Only provide recommendations and insights based on the actual financial data provided. Do not include generic advice.`;

    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini", // Using cost-effective DeepSeek model for daily recommendations
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content (recommendations, insights, descriptions) must be in ${getLanguageLabel(normalizedLanguage)}.

You are an expert financial advisor who provides personalized, actionable recommendations based on real user data. Always return valid JSON.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 1000,
      temperature: 0.3 // Moderate creativity for personalized recommendations
    });

    const aiResponse = JSON.parse(response.choices[0].message.content || '{}');

    // Ensure proper data structure
    const recommendations = Array.isArray(aiResponse.recommendations) 
      ? aiResponse.recommendations.map((rec, index) => ({
          id: rec.id || `rec-${index + 1}`,
          type: rec.type || 'general',
          priority: rec.priority || 'medium',
          title: rec.title || 'Financial Task',
          description: rec.description || 'Complete this financial task',
          action: rec.action || 'Take action on this recommendation',
          impact: rec.impact || 'Positive financial impact',
          timeToComplete: rec.timeToComplete || '10 minutes'
        }))
      : [];

    const insights = Array.isArray(aiResponse.insights)
      ? aiResponse.insights.map((insight, index) => ({
          id: insight.id || `insight-${index + 1}`,
          insight: insight.insight || 'Financial insight based on your data',
          basedOn: insight.basedOn || 'Transaction analysis',
          confidence: Number(insight.confidence) || 0.7,
          timeframe: insight.timeframe || 'Recent activity'
        }))
      : [];

    const result = {
      recommendations,
      insights
    };

    // Success logging removed for production

    return result;

  } catch (error) {
    console.error('Error generating daily recommendations:', error);
    throw error;
  }
}

export async function generateFinancialHealthScore(financialData: {
  transactions: Array<{
    id: number;
    amount: string;
    description: string;
    date: string;
    type: string;
    categoryName: string;
  }>;
  budgets: Array<{
    categoryId: number;
    amount: string;
    spent: number;
  }>;
  summary: {
    totalIncome: number;
    totalExpenses: number;
    netBalance: number;
  };
}, language: string = 'en-us'): Promise<FinancialHealthData> {
  const normalizedLanguage = normalizeLanguageCode(language);
  try {
    const { transactions, budgets, summary } = financialData;

    // Create a more stable hash that focuses on significant financial changes
    const stableData = {
      transactionCount: transactions.length,
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpenses,
      budgetCount: budgets.length,
      recentTransactions: transactions
        .slice(0, 10)
        .map(t => ({
          amount: Math.round(parseFloat(t.amount)),
          type: t.type,
          categoryName: t.categoryName
        }))
    };

    // No caching in Fly.io - caching handled by main application

    // Prepare data for AI analysis
    const recentTransactions = transactions
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 50);

    const categorySpending = new Map();
    transactions.forEach(t => {
      if (t.type === 'expense') {
        const current = categorySpending.get(t.categoryName) || 0;
        categorySpending.set(t.categoryName, current + parseFloat(t.amount));
      }
    });

    // Ultra-optimize for speed - minimal data processing
    const savingsRate = summary.totalIncome > 0 ? ((summary.totalIncome - summary.totalExpenses) / summary.totalIncome * 100) : 0;
    
    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `CRITICAL: You MUST respond exclusively in ${getLanguageLabel(normalizedLanguage)}. ${getLanguageLabel(normalizedLanguage) !== 'English' ? 'Never use English words.' : ''} ALL text content (status, factors, aiInsight, recommendations) must be in ${getLanguageLabel(normalizedLanguage)}.

You are an advanced financial health AI that calculates personalized financial health scores using sophisticated analysis beyond traditional metrics.

Your analysis should consider:
- Spending patterns and volatility
- Seasonal trends in expenses
- Category distribution and priorities
- Financial behavior consistency
- Risk factors and resilience
- Personalized weight adjustments based on user's situation

Provide a comprehensive financial health score from 0-100 with detailed factor breakdown.

Respond with JSON in this format:
{
  "score": 85,
  "status": "Good",
  "color": "blue",
  "factors": [
    {
      "name": "Adaptive Spending Control",
      "score": 25,
      "max": 30,
      "status": "good",
      "aiInsight": "Your spending shows good consistency with minor seasonal variations"
    }
  ],
  "icon": "TrendingUp",
  "aiAnalysis": {
    "personalizedFactors": ["Custom factor explanations"],
    "riskAssessment": "Overall risk level and factors",
    "recommendations": ["Personalized recommendations"],
    "confidence": 0.87
  }
}`
        },
        {
          role: "user",
          content: `Analyze this financial data for a personalized health score:

Financial Summary:
- Income: $${summary.totalIncome}
- Expenses: $${summary.totalExpenses}
- Net Balance: $${summary.netBalance}

Transaction History (${recentTransactions.length} transactions):
${recentTransactions.slice(0, 20).map(t => 
  `- ${t.description}: $${t.amount} (${t.categoryName || 'Other'}) on ${(t.date || '').toString().split('T')[0] || 'Unknown date'}`
).join('\n')}

Budgets: ${budgets.length} active budgets

CRITICAL REQUIREMENTS:
1. personalizedFactors array: Provide at least 3 specific insights about this user's spending patterns, habits, or financial behavior based on their actual transactions shown above
2. recommendations array: Provide at least 3 actionable recommendations to improve their financial health
3. DO NOT return empty arrays - always provide meaningful content

Example format you MUST follow:
"personalizedFactors": [
  "You spend most on [category] which is [percentage]% of your expenses",
  "Your income vs expenses ratio suggests [specific observation]",
  "Your transaction frequency shows [pattern analysis]"
]
"recommendations": [
  "Reduce [specific category] spending by [amount] to improve savings", 
  "Set up a budget for [category] to limit monthly spending",
  "Track [specific behavior] to optimize your financial health"
]

NEVER return empty arrays for personalizedFactors or recommendations.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 800
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    

    
    const processedResult = {
      score: Math.max(0, Math.min(100, result.score || 50)),
      status: result.status || 'Fair',
      color: result.color || 'yellow',
      factors: result.factors || [],
      icon: result.icon || 'Shield',
      aiAnalysis: {
        personalizedFactors: result.aiAnalysis?.personalizedFactors || [],
        riskAssessment: result.aiAnalysis?.riskAssessment || 'Standard risk assessment',
        recommendations: result.aiAnalysis?.recommendations || [],
        confidence: Math.max(0, Math.min(1, result.aiAnalysis?.confidence || 0.7))
      }
    };



    // Convert to frontend-expected format
    const healthData: FinancialHealthData = {
      score: processedResult.score,
      trend: 'stable', // Default trend
      category: processedResult.status.toLowerCase() === 'excellent' ? 'excellent' :
                processedResult.status.toLowerCase() === 'good' ? 'good' :
                processedResult.status.toLowerCase() === 'fair' ? 'fair' : 'poor',
      insights: Array.isArray(processedResult.aiAnalysis?.personalizedFactors) ? processedResult.aiAnalysis.personalizedFactors : [],
      achievements: Array.isArray(processedResult.factors) ? processedResult.factors.filter((f: any) => f.status === 'good').map((f: any) => f.aiInsight).filter(Boolean) : [],
      warnings: Array.isArray(processedResult.aiAnalysis?.recommendations) ? processedResult.aiAnalysis.recommendations : []
    };

    // No caching in Fly.io - handled by main application

    return healthData;
  } catch (error) {
    console.error('Error generating financial health score:', error);

    // Return fallback data based on simple calculations
    const { summary } = financialData;
    const savingsRate = summary.totalIncome > 0 ? 
      (summary.totalIncome - summary.totalExpenses) / summary.totalIncome : 0;

    let score = 50;
    let category: 'excellent' | 'good' | 'fair' | 'poor' = 'fair';

    if (savingsRate > 0.2) {
      score = 85;
      category = 'excellent';
    } else if (savingsRate > 0.1) {
      score = 70;
      category = 'good';
    } else if (savingsRate > 0) {
      score = 55;
      category = 'fair';
    } else {
      score = 30;
      category = 'poor';
    }

    return {
      score,
      trend: 'stable',
      category,
      insights: ['Financial analysis temporarily unavailable'],
      achievements: summary.netBalance > 0 ? ['Positive net balance'] : [],
      warnings: summary.netBalance < 0 ? ['Expenses exceed income'] : []
    };
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ai-processor', model: 'gpt-4o-mini' });
});

// Unified AI endpoint - stateless processing only
app.post("/execute-gpt-task", async (req, res) => {
  const { task, userId, payload } = req.body;

  if (!task || !userId || !payload) {
    return res.status(400).json({ error: 'Missing required fields: task, userId, payload' });
  }

  try {
    console.log(`Processing ${task} for user ${userId}`);
    let result;

    switch (task) {
      case "contextual-tips":
        console.log('[contextual-tips] Processing request with payload:', JSON.stringify(payload, null, 2));
        
        // Validate and fix payload structure for contextual tips
        const contextualPayload = {
          summary: payload.summary || {},
          transactions: payload.transactions || [],
          budgets: payload.budgets || [],
          goals: payload.goals || [],
          selectedMonth: payload.selectedMonth || new Date().toISOString().slice(0, 7),
          language: payload.language || 'en-us'
        };
        
        // Generate summary from transactions if missing or incomplete
        if (!payload.summary || payload.summary.totalIncome === undefined) {
          console.log('[contextual-tips] Generating summary from transactions');
          const validTransactions = contextualPayload.transactions || [];
          const totalIncome = validTransactions.filter(t => t.type === 'income').reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
          const totalExpenses = validTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
          contextualPayload.summary = {
            totalIncome,
            totalExpenses,
            netBalance: totalIncome - totalExpenses,
            transactionCount: validTransactions.length
          };
        }
        
        console.log('[contextual-tips] Final payload:', JSON.stringify(contextualPayload, null, 2));
        result = await generateContextualFinancialTips(contextualPayload);
        console.log('[contextual-tips] Result:', JSON.stringify(result, null, 2));
        break;
      
      case "financial-tips":
        // Fix payload structure for financial tips - map frontend payload to expected format
        const tipsPayload = {
          totalIncome: payload.totalIncome,
          totalExpenses: payload.totalExpenses,
          transactionsByCategory: payload.categories || payload.transactionsByCategory || [],
          recentTransactions: payload.transactions || payload.recentTransactions || [],
        };
        result = await generateFinancialTips(tipsPayload, payload.language || 'en-us');
        break;

      case "daily-recommendations":
        // Fix payload structure for daily recommendations
        const dailyPayload = {
          summary: payload.summary,
          transactions: payload.transactions,
          budgets: payload.budgets,
          categories: payload.categories
        };
        result = await generateDailyRecommendations(dailyPayload, payload.language || 'en-us');
        break;

      case "expense-predictions":
        result = await generateExpensePredictions(payload.transactions, payload.language || 'en-us');
        break;

      case "financial-health-score":
        // Add defensive checks for payload structure
        if (!payload.transactions || !Array.isArray(payload.transactions)) {
          result = {
            score: 50,
            trend: 'stable',
            category: 'fair',
            insights: ['Unable to analyze - insufficient transaction data'],
            achievements: [],
            warnings: ['Please add more transaction data for accurate analysis']
          };
        } else {
          result = await generateAIFinancialHealthScore(payload, payload.language || 'en-us');
        }
        break;

      case "spending-insights":
        result = await generateSpendingInsights(payload.transactions, payload.language || 'en-us');
        break;

      case "trend-predictions":
        result = await generateTrendPredictions(payload.transactions, payload.budgets, payload.language || 'en-us');
        break;

      case "parseBankStatement":
        result = await parseBankStatement(payload.text, payload.language || 'en-us');
        break;

      case "categorizeExpense":
        result = await categorizeExpense(
          payload.description,
          payload.amount,
          payload.language || 'en-us',
          payload.userTransactions || [],
          payload.userCategories || []
        );
        break;

      case "voice-extraction":
        // Direct OpenAI call for voice extraction using the same prompt from voiceRoutes.ts
        const { prompt } = payload;
        if (!prompt) {
          return res.status(400).json({ error: 'Missing prompt for voice extraction' });
        }
        
        const completion = await getAIClient().chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 500
        });
        result = completion.choices[0]?.message?.content || '';
        break;

      default:
        return res.status(400).json({ error: `Unknown task: ${task}` });
    }

    // Return result directly - no caching on Fly.io
    res.json(result);
  } catch (error: any) {
    console.error(`Error processing ${task}:`, error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Legacy endpoints for backward compatibility
app.post('/generate-financial-tip', async (req, res) => {
  try {
    const language = normalizeLanguageCode(req.body.language || 'en-us');
    const result = await generateFinancialTips(req.body, language);
    res.json(result);
  } catch (error) {
    console.error('Legacy financial tip error:', error);
    res.status(500).json({ error: 'Financial tip generation failed' });
  }
});

app.post('/generate-daily-recommendation', async (req, res) => {
  try {
    const result = await generateDailyRecommendations(req.body);
    res.json(result);
  } catch (error) {
    console.error('Legacy daily recommendation error:', error);
    res.status(500).json({ error: 'Daily recommendation generation failed' });
  }
});

// Voice extraction endpoint for voice input processing
app.post('/api/ai/voice-extract', async (req, res) => {
  try {
    const { prompt, userId, model } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Missing required field: prompt' });
    }
    
    console.log(`[voice-extract] Processing voice extraction for user ${userId?.substring(0, 8)}...`);
    
    const completion = await getAIClient().chat.completions.create({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 500
    });
    
    const result = completion.choices[0]?.message?.content || '';
    
    console.log(`[voice-extract] Voice extraction completed successfully`);
    
    res.json({ 
      result,
      completion: result // Support both response formats
    });
  } catch (error: any) {
    console.error('[voice-extract] Voice extraction error:', error);
    res.status(500).json({ error: error.message || 'Voice extraction failed' });
  }
});

/**
 * Parse bank statement text and extract transactions using AI
 * Specialized function for PDF bank statement processing
 */
async function parseBankStatement(text: string, language: string): Promise<any> {
  const languageLabel = getLanguageLabel(language);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const bankStatementPrompt = `You are an expert financial data extraction system specialized in bank statement analysis. 

CRITICAL MISSION: Extract ALL transactions with 100% accuracy from bank statement text.
CRITICAL: You MUST respond exclusively in ${languageLabel}. ${languageLabel !== 'English' ? 'Never use English words.' : ''}

MANDATORY JSON OUTPUT FORMAT:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "Transaction description in ${languageLabel}",
      "amount": 123.45,
      "type": "income" or "expense",
      "confidence": 0.95,
      "rawText": "Original text from statement",
      "detectedFormat": "Format type detected"
    }
  ]
}

EXTRACTION RULES:
1. Date Formats: Support DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, and text dates
2. Amount Detection: Handle various currency symbols (€, $, £, Kč) and number formats
3. Transaction Types: income (deposits, transfers in, salary) vs expense (payments, transfers out, fees)
4. Description: Clean merchant/payee names, remove bank codes
5. Confidence: 0.9+ for clear transactions, 0.7-0.9 for moderate clarity, <0.7 for unclear
6. Skip: Header/footer text, account summaries, balance information

CRITICAL QUALITY STANDARDS:
- Zero missed transactions
- 100% accurate date parsing
- Correct positive/negative amount handling
- Clean, readable descriptions in ${languageLabel}
- High confidence scores for clear data

Respond ONLY with valid JSON. No explanations or additional text.`;

  try {
    const response = await getAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: bankStatementPrompt
        },
        {
          role: "user",
          content: `Please analyze this bank statement text and extract all transactions:\n\n${text}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    
    if (result.transactions && Array.isArray(result.transactions)) {
      return {
        transactions: result.transactions.map((tx: any) => ({
          date: tx.date || '',
          description: tx.description || '',
          amount: parseFloat(tx.amount) || 0,
          type: tx.type || 'expense',
          confidence: tx.confidence || 0.8,
          rawText: tx.rawText || '',
          detectedFormat: tx.detectedFormat || 'unknown',
          category: null // Will be filled by categorization
        }))
      };
    }

    return { transactions: [] };

  } catch (error) {
    console.error('Bank statement parsing error:', error);
    throw new Error('Failed to parse bank statement transactions');
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`AI Processor server running on port ${port}`);
});