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
  Info
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Hello! I'm your Gemini Notion Assistant. I can help you manage your Notion workspace. Try asking me to create a page, search for something, or even generate a database!" }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = { role: "user" as const, content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      const data = await response.json();
      if (data.error) {
        setMessages(prev => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
      } else {
        setMessages(prev => [...prev, { role: "assistant", content: data.content }]);
      }
    } catch (error: any) {
      setMessages(prev => [...prev, { role: "assistant", content: "Failed to connect to the server." }]);
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
            <h1 className="font-bold text-lg tracking-tight leading-none">Gemini Notion Assistant</h1>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mt-1">Autonomous Workspace Agent</p>
          </div>
        </div>
        <button 
          onClick={() => setShowSetup(true)}
          className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-indigo-600 transition-colors bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-full"
        >
          <Settings className="w-4 h-4" />
          Setup
        </button>
      </header>

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
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Actions */}
        {messages.length === 1 && !isLoading && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl px-4">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-slate-800 mb-2">What can I help you with today?</h2>
              <p className="text-slate-500">I can automate your Notion workspace using natural language.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { icon: <Plus className="w-4 h-4" />, label: "Create a page about Edge Computing", prompt: "Create a structured page about Edge Computing with sections for Overview, Concepts, and Use Cases." },
                { icon: <Database className="w-4 h-4" />, label: "Create a task database", prompt: "Create a task database with columns for Task Name, Priority (Select), and Deadline (Date)." },
                { icon: <Search className="w-4 h-4" />, label: "Search my research notes", prompt: "Search for any pages related to 'AI research' in my workspace." },
                { icon: <ImageIcon className="w-4 h-4" />, label: "Generate an architecture diagram", prompt: "Generate an architecture diagram for a microservices system and add it to a new page." }
              ].map((action, i) => (
                <button
                  key={i}
                  onClick={() => setInput(action.prompt)}
                  className="bg-white border border-slate-200 p-4 rounded-xl hover:border-indigo-400 hover:shadow-md transition-all text-left flex items-start gap-3 group"
                >
                  <div className="bg-slate-50 p-2 rounded-lg group-hover:bg-indigo-50 transition-colors">
                    {React.cloneElement(action.icon as React.ReactElement, { className: "w-4 h-4 text-slate-600 group-hover:text-indigo-600" })}
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
