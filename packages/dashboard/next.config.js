/** @type {import('next').NextConfig} */
module.exports = {
	reactStrictMode: true,
	swcMinify: true,
	// In production nginx forwards /api to the API; this does the same for local development
	async rewrites() {
		if (process.env.NODE_ENV !== "development") {
			return [];
		}

		return [{ source: "/api/:path*", destination: "http://localhost:4000/:path*" }];
	},
	webpack(config) {
		config.module.rules.push({
			test: /\.svg$/,
			use: ["@svgr/webpack"],
		});

		config.module.rules.push({
			test: [/src\/(components|layouts)\/index.ts/i],
			sideEffects: false,
		});

		return config;
	},
};
