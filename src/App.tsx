import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import { 
  Send, 
  Loader2, 
  Settings, 
  Key, 
  Layout,
  ExternalLink,
  Plus,
  Trash2,
  Database,
  FileText,
  Search,
  Image as ImageIcon,
  User,
  Bot,
  X,
  ChevronRight,
  Info,
  BarChart
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { 
  BarChart as RechartsBarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from "recharts";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899'];

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChartData {
  type: "bar" | "pie";
  title: string;
  data: any[];
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Hello! I'm your Gemini Notion Assistant. I can help you manage your Notion workspace. Try asking me to create a page, search for something, or even generate a database!" }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [currentPage, setCurrentPage] = useState<"chat" | "insights">("chat");
  const [error, setError] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<{ hasGemini: boolean; hasNotion: boolean; hasPageId: boolean } | null>(null);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [knowledgeBase, setKnowledgeBase] = useState<{ title: string; summary: string }[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const checkHealth = async () => {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        const data = await res.json();
        setApiStatus(data.env);
      }
    } catch (e) {
      console.error("Health check failed:", e);
    }
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Parse AI response for charts and knowledge base updates
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant") {
      // Look for JSON blocks
      const jsonMatch = lastMessage.content.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          if (data.type === "bar" || data.type === "pie") {
            setChartData(data);
          } else if (data.knowledge_base) {
            setKnowledgeBase(prev => [...prev, ...data.knowledge_base]);
          }
        } catch (e) {
          console.error("Failed to parse JSON from AI response", e);
        }
      }
    }
  }, [messages]);

  const handleRetry = async () => {
    if (messages.length < 2) return;
    const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
    if (!lastUserMessage) return;
    
    setInput(lastUserMessage.content);
    setMessages(prev => prev.slice(0, prev.lastIndexOf(lastUserMessage)));
  };

  const fetchWithRetry = async (url: string, options: any, retries = 3, backoff = 5000): Promise<Response> => {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 60000); // 60s timeout
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(id);

      if ((response.status === 504 || response.status === 429) && retries > 0) {
        console.warn(`${response.status} Error for ${url}. Retrying in ${backoff}ms...`);
        await new Promise(res => setTimeout(res, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 2);
      }
      
      return response;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error("Request timed out. The server is taking too long to respond.");
      }
      if (retries > 0) {
        console.warn(`Request failed for ${url}. Retrying in ${backoff}ms...`, error);
        await new Promise(res => setTimeout(res, backoff));
        return fetchWithRetry(url, options, retries - 1, backoff * 1.5);
      }
      throw error;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = { role: "user" as const, content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithRetry("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      if (!response.ok) {
        if (response.status === 504) {
          throw new Error("The server timed out. This usually happens when Notion or the AI model is slow. Please try a simpler request.");
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        setError(data.error);
        setMessages(prev => [...prev, { role: "assistant", content: `**Error:** ${data.error}` }]);
      } else {
        setMessages(prev => [...prev, { role: "assistant", content: data.content }]);
      }
    } catch (err: any) {
      const errorMessage = err.message || "Failed to connect to the server.";
      setError(errorMessage);
      setMessages(prev => [...prev, { role: "assistant", content: `**Connection Error:** ${errorMessage}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-6 flex-shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg">
            <Layout className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight leading-none">Notion AI Assistant</h1>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Intelligent Workspace Agent</p>
              {apiStatus && (
                <div className="flex gap-1 items-center ml-2">
                  <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.hasGemini ? "bg-green-500" : "bg-red-500")} title="Gemini API" />
                  <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.hasNotion ? "bg-green-500" : "bg-red-500")} title="Notion API" />
                  <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.hasPageId ? "bg-green-500" : "bg-red-500")} title="Notion Page ID" />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setCurrentPage("chat")}
            className={cn(
              "px-3 py-1.5 rounded-full text-sm font-medium transition-all",
              currentPage === "chat" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
            )}
          >
            Chat
          </button>
          <button 
            onClick={() => setCurrentPage("insights")}
            className={cn(
              "px-3 py-1.5 rounded-full text-sm font-medium transition-all",
              currentPage === "insights" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
            )}
          >
            Insights
          </button>
          <div className="w-px h-4 bg-slate-200 mx-2" />
          <button 
            onClick={() => setShowSetup(true)}
            className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-indigo-600 transition-colors bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-full"
          >
            <Settings className="w-4 h-4" />
            Setup
          </button>
        </div>
      </header>

      {/* Main Content */}
      {currentPage === "chat" ? (
        <>
          {/* Main Chat Area */}
          <main className="flex-grow overflow-y-auto px-4 py-8 flex flex-col items-center relative">
            <div className="w-full max-w-3xl space-y-6">
              {messages.map((msg, idx) => (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  key={idx}
                  className={cn(
                    "flex gap-4 w-full",
                    msg.role === "user" ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 shadow-sm",
                    msg.role === "user" ? "bg-indigo-600" : "bg-white border border-slate-200"
                  )}>
                    {msg.role === "user" ? (
                      <User className="w-4 h-4 text-white" />
                    ) : (
                      <Bot className="w-4 h-4 text-indigo-600" />
                    )}
                  </div>
                  <div className={cn(
                    "max-w-[85%] p-4 rounded-2xl shadow-sm",
                    msg.role === "user" 
                      ? "bg-indigo-600 text-white rounded-tr-none" 
                      : "bg-white border border-slate-200 text-slate-800 rounded-tl-none"
                  )}>
                    <div className={cn("markdown-body", msg.role === "user" && "text-white")}>
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </motion.div>
              ))}
              {isLoading && (
                <div className="flex gap-4 w-full">
                  <div className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center flex-shrink-0 mt-1 animate-pulse">
                    <Bot className="w-4 h-4 text-indigo-400" />
                  </div>
                  <div className="bg-white border border-slate-200 p-4 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                    <span className="text-sm text-slate-500 font-medium italic">Assistant is thinking...</span>
                  </div>
                </div>
              )}
              {error && !isLoading && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-red-50 border border-red-100 p-4 rounded-2xl flex flex-col items-center gap-3 w-full max-w-md mx-auto"
                >
                  <div className="flex items-center gap-2 text-red-600">
                    <Info className="w-4 h-4" />
                    <span className="text-sm font-medium">Something went wrong</span>
                  </div>
                  <p className="text-xs text-red-500 text-center leading-relaxed">
                    {error.includes("429") || error.includes("quota") 
                      ? "Gemini API quota exceeded. This happens when there are too many requests. Please wait a moment and try again."
                      : error}
                  </p>
                  <button
                    onClick={handleRetry}
                    className="bg-red-600 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-red-700 transition-all active:scale-95"
                  >
                    Retry Request
                  </button>
                </motion.div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick Actions */}
            {messages.length === 1 && !isLoading && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl px-4">
                <div className="text-center mb-8">
                  <h2 className="text-2xl font-bold text-slate-800 mb-2">How can I help with your workspace?</h2>
                  <p className="text-slate-500">I can manage your Notion pages and research information for you.</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { icon: <Database className="w-4 h-4" />, label: "Create Task Database", prompt: "Create a database for 'Project Tasks' with Status (Select), Priority (Select), and Due Date (Date) properties." },
                    { icon: <Search className="w-4 h-4" />, label: "Analyze Workspace", prompt: "Search my workspace for 'Research' pages, summarize the key ideas, and convert them into a bulleted list of action items." },
                    { icon: <FileText className="w-4 h-4" />, label: "Summarize Meeting", prompt: "Find my 'Weekly Sync' page, extract the key points, and convert the notes into a checklist of action items." },
                    { icon: <Layout className="w-4 h-4" />, label: "Generate Insights", prompt: "Query my 'Project Tasks' database, filter for 'High Priority' tasks, and generate a summary of our current progress." }
                  ].map((action, i) => (
                    <button
                      key={i}
                      onClick={() => setInput(action.prompt)}
                      className="bg-white border border-slate-200 p-4 rounded-xl hover:border-indigo-400 hover:shadow-md transition-all text-left flex items-start gap-3 group"
                    >
                      <div className="bg-slate-50 p-2 rounded-lg group-hover:bg-indigo-50 transition-colors">
                        {React.cloneElement(action.icon as React.ReactElement<{ className?: string }>, { className: "w-4 h-4 text-slate-600 group-hover:text-indigo-600" })}
                      </div>
                      <span className="text-sm font-medium text-slate-700">{action.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </main>

          {/* Input Area */}
          <div className="bg-white border-t border-slate-200 p-4 flex-shrink-0 z-20">
            <div className="max-w-3xl mx-auto flex items-end gap-3">
              <form onSubmit={handleSubmit} className="flex-grow relative">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder="Type your instruction for Notion..."
                  className="w-full min-h-[56px] max-h-32 p-4 pr-12 rounded-2xl border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all resize-none text-slate-700 leading-relaxed bg-slate-50"
                  disabled={isLoading}
                />
                <button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="absolute right-3 bottom-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white p-2 rounded-xl transition-all shadow-lg shadow-indigo-200 active:scale-95"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
            <p className="text-[10px] text-center text-slate-400 mt-2">
              Press Enter to send • Shift + Enter for new line
            </p>
          </div>
        </>
      ) : (
        <main className="flex-grow overflow-y-auto px-4 py-8 flex flex-col items-center">
          <div className="w-full max-w-3xl">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm"
            >
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h2 className="text-3xl font-bold text-slate-800">Workspace Insights</h2>
                  <p className="text-slate-500 text-sm">AI-generated analysis and visual representations.</p>
                </div>
                <button 
                  onClick={() => { setKnowledgeBase([]); setChartData(null); }}
                  className="text-xs text-slate-400 hover:text-red-500 transition-colors"
                >
                  Clear All
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                  <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-indigo-600" />
                    Knowledge Base
                  </h3>
                  <p className="text-xs text-slate-500 mb-4">Summaries extracted from your Notion pages.</p>
                  <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                    {knowledgeBase.length > 0 ? (
                      knowledgeBase.map((item, i) => (
                        <div key={i} className="bg-white p-3 rounded-xl border border-slate-200 text-xs text-slate-600 shadow-sm">
                          <strong className="block text-slate-800 mb-1">{item.title}</strong>
                          <p className="leading-relaxed">{item.summary}</p>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-8 text-slate-400 italic text-xs">
                        No insights generated yet. Ask the AI to summarize pages or analyze your workspace.
                      </div>
                    )}
                  </div>
                </div>
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                  <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                    <BarChart className="w-4 h-4 text-indigo-600" />
                    Representations
                  </h3>
                  <p className="text-xs text-slate-500 mb-4">Visual data from your Notion databases.</p>
                  <div className="h-[250px] bg-white rounded-xl border border-slate-200 p-4 flex flex-col items-center justify-center">
                    {chartData ? (
                      <>
                        <h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-wider">{chartData.title}</h4>
                        <ResponsiveContainer width="100%" height="100%">
                          {chartData.type === "bar" ? (
                            <RechartsBarChart data={chartData.data}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} />
                              <YAxis fontSize={10} tickLine={false} axisLine={false} />
                              <RechartsTooltip 
                                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', fontSize: '10px' }}
                              />
                              <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
                            </RechartsBarChart>
                          ) : (
                            <PieChart>
                              <Pie
                                data={chartData.data}
                                cx="50%"
                                cy="50%"
                                innerRadius={40}
                                outerRadius={60}
                                paddingAngle={5}
                                dataKey="value"
                              >
                                {chartData.data.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                ))}
                              </Pie>
                              <RechartsTooltip />
                            </PieChart>
                          )}
                        </ResponsiveContainer>
                      </>
                    ) : (
                      <div className="text-center py-8 text-slate-400 italic text-xs">
                        No charts generated yet. Ask the AI to "generate a bar chart of my task status".
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </main>
      )}

      {/* Setup Modal */}
      <AnimatePresence>
        {showSetup && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSetup(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-600 p-2 rounded-lg">
                    <Key className="w-5 h-5 text-white" />
                  </div>
                  <h2 className="text-xl font-bold">Setup Instructions</h2>
                </div>
                <button 
                  onClick={() => setShowSetup(false)}
                  className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>
              
              <div className="p-8 overflow-y-auto space-y-8">
                <section>
                  <h3 className="font-bold text-lg mb-4 flex items-center gap-3">
                    <span className="bg-indigo-100 text-indigo-600 w-7 h-7 rounded-full flex items-center justify-center text-sm">1</span>
                    Notion API Integration
                  </h3>
                  <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                    <p className="text-slate-600 text-sm leading-relaxed">
                      Go to <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer" className="text-indigo-600 font-semibold hover:underline inline-flex items-center gap-1">Notion My Integrations <ExternalLink className="w-3 h-3" /></a> and create a new <strong>Internal Integration</strong>.
                    </p>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Secret Key Name</label>
                      <div className="bg-white p-3 rounded-xl border border-slate-200 text-sm font-mono text-indigo-600">
                        NOTION_API_KEY
                      </div>
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="font-bold text-lg mb-4 flex items-center gap-3">
                    <span className="bg-indigo-100 text-indigo-600 w-7 h-7 rounded-full flex items-center justify-center text-sm">2</span>
                    Target Page ID
                  </h3>
                  <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 space-y-4">
                    <p className="text-slate-600 text-sm leading-relaxed">
                      Open the Notion page you want to use as the root. Copy the ID from the URL (the 32-character string at the end).
                    </p>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Secret Key Name</label>
                      <div className="bg-white p-3 rounded-xl border border-slate-200 text-sm font-mono text-indigo-600">
                        NOTION_PAGE_ID
                      </div>
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="font-bold text-lg mb-4 flex items-center gap-3">
                    <span className="bg-indigo-100 text-indigo-600 w-7 h-7 rounded-full flex items-center justify-center text-sm">3</span>
                    Final Connection
                  </h3>
                  <div className="bg-amber-50 p-6 rounded-2xl border border-amber-100">
                    <div className="flex gap-3">
                      <Info className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                      <p className="text-amber-900 text-sm leading-relaxed font-medium">
                        CRITICAL: In Notion, go to your target page, click "..." → "Add connections" → Search for your integration name and select it.
                      </p>
                    </div>
                  </div>
                </section>
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end">
                <button 
                  onClick={() => setShowSetup(false)}
                  className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                >
                  Got it!
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
