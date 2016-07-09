// Helper functions

// Dot product of two vectors
let dot = function(v1, v2) {
    let s = 0;
    for(let i = 0; i < v1.length; i++) {
        s += v1[i] * v2[i];
    }
    return s
}

// Wrap a slope m and an intercept b into a linear function
let linear_function = function(m, b) {
    return function(x) {
        return b + m * x;
    }
}

// Expand a number into an array of powers of that number.
let expand_into_powers = function(x, degree) {
    let p = [1];
    let y = x;
    for(let i = 1; i <= degree; i++) {
        p.push(y);
        y = y * x;
    }
    return p;
}

// Return a polynomial function given an array of its coefficients
let polynomial_function = function(betas) {
    return function(x) {
        xs = expand_into_powers(x, betas.length - 1);
        return dot(xs, betas);
    }
}

// Weighted mean of x with weights w.  Weights may be un-normalized.
let wmean = function(x, w) {
    let r = [];
    for(i = 0; i < x.length; i++) {
        r.push(x[i]*w[i]);
    }
    return d3.sum(r) / d3.sum(w);
}

// Simple linear regression on data (ys, xs).
let linear_regressor = function(xs, ys) {
    let xmean = d3.mean(xs);
    let ymean = d3.mean(ys);
    let xymean = d3.mean(d3.zip(xs, ys).map(p => p[0]*p[1]));
    let xsqmean = d3.mean(d3.zip(xs, xs).map(p => p[0]*p[1]));
    let beta = (xymean - xmean * ymean) / (xsqmean - xmean * xmean);
    let betaz = ymean - beta * xmean;
    return linear_function(beta, betaz);
};


// Simple linear regression with sample weights.
let weighted_linear_regressor = function(xs, ys, ws) {
    let xmean = wmean(xs, ws);
    let ymean = wmean(ys, ws);
    let xymean = wmean(d3.zip(xs, ys).map(p => p[0]*p[1]), ws);
    let xsqmean = wmean(d3.zip(xs, xs).map(p => p[0]*p[1]), ws);
    let beta = (xymean - xmean * ymean) / (xsqmean - xmean * xmean);
    let betaz = ymean - beta * xmean;
    return linear_function(beta, betaz)
};


make_ridge_shrinkage_matrix = function(n, lambda) {
    let shrink_matrix = numeric.diag(numeric.rep([n + 1], lambda));
    shrink_matrix[0][0] = 0;  // Don't shrink intercept.
    return shrink_matrix
}

fit_ridge_regression = function(X, ys, lambda) {
    let Xt = numeric.transpose(X);
    let XtX = numeric.dot(Xt, X);
    let Xty = numeric.dot(Xt, ys);
    let shrink_matrix = make_ridge_shrinkage_matrix(X[0].length, lambda);
    let betas = numeric.solve(numeric.add(XtX, shrink_matrix), Xty);
    return betas
}

// Generate a simple basis of cubic splines with knots at a fixed set of
// points.
let spline_basis = function(knots) {
    let basis = [];
    basis.push(x => 1);
    basis.push(x => x);
    basis.push(x => x*x);
    basis.push(x => x*x*x);
    console.log(knots);
    console.log("Entering for loop");
    for(let i = 0; i < knots.length; i++) {
        console.log(knots[i]);
        basis.push(x => Math.max(Math.pow(x - knots[i], 3), 0));
    }
    return basis
}

evaluate_spline_basis = function(basis, xs) {
    return xs.map(x => basis.map(s => s(x)))
}

// Convert a function that maps numbers to numbers into one which maps
// arrays to arrays.
let vectorize = function(f) {
    return function(arr) {
        return arr.map(f)
    }
}


// A namespace for smoother functions.
// Smoother functions should consume two numeric arrays, and return a mapping
// from numeric arrays to numeric arrays.
smoothers = {

    /* Trivial global mean smoother.

    Simply return the mean of the y values as the smoothed data.

    Hyperparamters: None
    */
    "smooth-type-mean": {

        "label": "Constant Mean",

        "smoother": function(parameters) {
            return function(xs, ys) {
                let mean = d3.mean(ys);
                return vectorize(x => mean)
            }
        },

        "parameters": []
    },

    /* Running mean smoother. 

    The smoothed value y at a given x is the mean value of the y data for
    those data with the closest k x data.

    Hyperparameters:
        k: Number of data points included in each side of the symmetric nbhd.
    */
    "smooth-type-runmean": {

        "label": "Running Mean",
    
        "smoother": function(parameters) {
            let k = Number(parameters["k"]);
            return function(xs, ys) {
                // Reorder xs and ys so that xs is in increasing order
                let psort = d3.zip(xs, ys).sort(function(a, b) {return a[0] - b[0]});
                let xsort = psort.map(p => p[0]);
                let ysort = psort.map(p => p[1]);
                let mean_of_symm_nbrd = function(newx) {
                    // TODO: Abstract out finding the local neighbourhood.
                    let pos_in_array = d3.bisect(xsort, newx);
                    // TODO: Check that you lined up the fenceposts.
                    let cutoffs = [
                        Math.max(0, pos_in_array - k), 
                        Math.min(xsort.length - 1, pos_in_array + k)
                    ];
                    return d3.mean(ysort.slice(cutoffs[0], cutoffs[1]));
                };
                return vectorize(mean_of_symm_nbrd);
            };
        },

        "parameters": [
            {"label": "Number of Neighbors", "name": "k", "min": 1, "max": 20, "step": 1}
        ]
    },

    /* Simple linear regression smoother. */
    "smooth-type-linreg": {

        "label": "Linear Regression",

        "smoother": function(parameters) {
            return function(xs, ys) {
                let linreg = linear_regressor(xs, ys);
                return vectorize(linreg);
            };
        },

        "parameters": []

    },


    /* Multi linear regression with a quadratic basis expansion and reidge
     *  regression shrinkage. 
     */
    "smooth-type-polyreg": {
    
        "label": "Polynomial Ridge Regression",

        "smoother": function(parameters) {
            let d = Number(parameters["degree"]);
            let lambda = Number(parameters["lambda"]);
            return function(xs, ys) {
                // Build the design matrix
                let X = [];
                for(let i = 0; i < xs.length; i++) {
                    let row = expand_into_powers(xs[i], d);
                    X.push(row)
                }
                // Solve the regression equations
                let betas = fit_ridge_regression(X, ys, lambda);
                return vectorize(polynomial_function(betas));
            };
        },

        "parameters": [
            {"label": "Polynomial Degree", "name": "degree", "min": 1, "max": 20, "step": 1},
            {"label": "Ridge Shrinkage", "name": "lambda", "min": 0, "max": .1, "step": .0005}
        ]

    },

    // Gaussian kernel smoother.
    "smooth-type-gaussk": {

        "label": "Gaussian Kernel Smoother",

        "smoother": function(parameters) {
            let lambda = Number(parameters["lambda"]);
            return function(xs, ys) {
                let gauss_kern_smooth = function(x) {
                    let ds = xs.map(function(xi) {return x - xi;});
                    let ws = ds.map(function(di) {return Math.exp(-di*di/lambda);});
                    let normc = d3.sum(ws); 
                    let normws = ws.map(function(wi) {return wi / normc;});
                    return d3.sum(d3.zip(normws, ys).map(function(p) {return p[0]*p[1]}));
                };
                return vectorize(gauss_kern_smooth)
            };
        },

        "parameters": [
            {"label": "Width of Kernel", "name": "lambda",
             "min": .001, "max": .05, "step": .001}
        ]

    },

    /* Running line smoother.
     * To calculate the smoothed value of y at a given x, first take together the
     * k data points closest to x.  Then fit a simple linear regression to these k
     * data points.  The smoothed value of y is the prediction made from this
     * linear regressor.
     */
    "smooth-type-runline": {

        "label": "Running Line",

        "smoother": function(parameters) {
            let k = Number(parameters["k"]);
            return function(xs, ys) {
                // Reorder xs and ys so that xs is in increasing order
                let psort = d3.zip(xs, ys).sort(function(a, b) {return a[0] - b[0]});
                let xsort = psort.map(function(p) {return p[0]});
                let ysort = psort.map(function(p) {return p[1]});
                let loc_lin_approx = function(newx) {
                    let pos_in_array = d3.bisect(xsort, newx);
                    // TODO: Check that you lined up the fenceposts.
                    let cutoffs = [
                        Math.max(0, pos_in_array - k), 
                        Math.min(xsort.length, pos_in_array + k)
                    ];
                    let locx =  xsort.slice(cutoffs[0], cutoffs[1]);
                    let locy =  ysort.slice(cutoffs[0], cutoffs[1]);
                    return linear_regressor(locx, locy)(newx);
                }
                return vectorize(loc_lin_approx);
            };
        },

        "parameters": [
            {"label": "Number of Neighbors", "name": "k", "min": 2, "max": 20, "step": 1}
        ]

    },

    "smooth-type-spline": {

        "label": "Cubic Spline (Fixed Knots)",

        "smoother": function(parameters) {
            let n = Number(parameters["n"]);
            let knots = numeric.linspace(0, 1, n + 2).slice(1, n + 1);
            let sp = spline_basis(knots);
            let lambda = Number(parameters["lambda"]);
            return function(xs, ys) {
                let X = evaluate_spline_basis(sp, xs);
                let betas = fit_ridge_regression(X, ys, lambda);
                let smooth_value = function(newx) {
                    let basis_expansion = sp.map(s => s(newx))
                    basis_expansion[0] = 1;
                    return numeric.dot(betas, basis_expansion);
                }
                return vectorize(smooth_value);
            };
        },

        "parameters": [
            {"label": "Number of Knots", "name": "n", "min": 2, "max": 10, "step": 1},
            {"label": "Ridge Shrinkage", "name": "lambda", "min": 0, "max": .01, "step": .00001}
        ]
    }


/*
    // Locally weighted linear regression smoother.
    "smooth-type-loess": function(xs, ys) {
        let k = 5
        let loess = function(x) {
            // Sort by increasing absolute distance from x.
            let psort = d3.zip(xs, ys).sort(function(a, b) {
                return Math.abs(x - a[0]) - Math.abs(x - b[0])}
            );
            let xsort = psort.map(function(p) {return p[0]}).slice(0, 7);
            let ysort = psort.map(function(p) {return p[1]}).slice(0, 7);
            let nearest_nbrs = psort.slice(0, 7);
            let ds = nearest_nbrs.map(function(p) {return Math.abs(p[0] - x)});
            let dsmax = d3.max(ds);
            let ws = ds.map(function(d) {
                return Math.pow(1 - d*d*d, 3) / (dsmax * dsmax * dsmax)
            });
            return weighted_linear_regressor(xsort, ysort, ws)(x);
        };
        return vectorize(loess)
    },
*/
};
