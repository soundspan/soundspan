"use client";

const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
};

export function HomeHero() {
    return (
        <div className="relative">
            {/* Quick gradient fade - yellow to purple */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-[#3b82f6]/15 via-blue-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#3b82f6]/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            {/* Hero Section - Compact */}
            <div className="relative">
                <div className="relative max-w-[1800px] mx-auto px-4 pt-6 pb-4">
                    <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
                        {getGreeting()}
                    </h1>
                </div>
            </div>
        </div>
    );
}
